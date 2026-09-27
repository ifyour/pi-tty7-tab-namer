/* tty7 tab-name — auto-name pi sessions and sync the name to the tty7 tab title.
 *
 * - Unnamed session → parallel LLM call (does not block the turn) summarizing
 *   intent into a ≤10-char name → setSessionName + tab title. Naming looks at
 *   the session's user messages (last 10) so a resumed old session gets named
 *   for the whole conversation, not just the latest prompt.
 * - Triggers: session_start (resume of an unnamed session) and the first
 *   before_agent_start while still unnamed (covers fresh sessions and retries).
 * - Manual `/name <x>` wins: once a name arrives from outside this extension,
 *   auto-naming never runs again for that session.
 * - resume/new/fork/quit: title follows the session's name; on shutdown the
 *   title is reset so the tab falls back to tty7's default.
 * - Reverse sync: a manual tab rename inside tty7 (tab_renamed event from
 *   `tty7 events --json`) is treated like `/name` — manual priority, auto-
 *   naming never overrides it afterwards. Bidirectional, no loop: our own
 *   OSC writes never emit tab_renamed.
 * - quit: the events listener child process is killed; if it dies mid-session
 *   reverse sync goes silent until the next session_start.
 *
 * Title channel note: pi core also writes the title (`π - name - cwd`) in its
 * own session_info_changed handler, which runs AFTER extension handlers. All
 * our title writes are therefore deferred by one tick to land last, and we
 * write exactly `{name}`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";

const NAME_PROMPT =
	"根据下面的用户消息记录，为这个会话起一个简短标题：不超过10个字，概括整个会话的主要意图，中文，不加引号、句号或任何前后缀，直接输出标题本身。\n\n<user-messages>\n";
const MAX_TOKENS = 512;
const NAME_TIMEOUT_MS = 20_000;
const HISTORY_MESSAGES = 10;
const HISTORY_CHARS = 2000;
// Subagent auto-name pattern (pi-subagents names child sessions "type#hex8",
// e.g. "general-purpose#c897cd1c"); such names must never reach the tab.
const SUBAGENT_NAME = /^[\w-]+#[0-9a-f]{8}$/i;
// tty7 CLI resolves via PATH (installed at /usr/local/bin/tty7 by the app);
// fall back to the app bundle binary for installs without the symlink.
const TTY7_EXE = process.env["TTY7_CLI"] ?? "/usr/local/bin/tty7";

/** Extract a clean title from raw model output. Exported for the self-test. */
export function sanitizeTitle(raw: string): string {
	const line = raw
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.length > 0);
	let t = (line ?? "").replace(/^["'「『《]|[」』》"'.,。]+$/g, "").trim();
	if (t.length > 20) t = t.slice(0, 20);
	return t;
}

function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.filter((b): b is { type: "text"; text: string } => b?.type === "text")
			.map((b) => b.text)
			.join(" ");
	}
	return "";
}

/** Recent user messages of the current branch, oldest first. */
function historyUserMessages(ctx: ExtensionContext): string[] {
	const out: string[] = [];
	try {
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "message") continue;
			const msg = entry.message as { role?: string; content?: unknown };
			if (msg?.role !== "user") continue;
			const text = messageText(msg.content).trim();
			if (text) out.push(text);
		}
	} catch {}
	return out.slice(-HISTORY_MESSAGES);
}

export default function (pi: ExtensionAPI) {
	if (!process.env["TTY7"]) return; // bridge convention: only inside tty7

	// Subagent sessions (pi-subagents spawns them in-process via
	// createAgentSession; they persist a parentSession header and share the same
	// tab) must never touch the title, or the child's name (e.g.
	// "general-purpose#c897cd1c") clobbers the main session's name.
	const isSubagent = (ctx: ExtensionContext): boolean => {
		try {
			return Boolean(ctx.sessionManager.getHeader()?.parentSession);
		} catch {
			return false;
		}
	};

	let gen = 0; // bumped on every session transition; in-flight naming must match
	let manual = false; // a name arrived that we did not set
	let suppressInfo = false; // the next session_info_changed is our own setSessionName
	let inFlight = false;
	let lastCustom: string | null = null; // title we manage; null = leave terminal default

	// --- reverse sync: tty7 tab rename → session name -----------------------
	// tty7 emits tab_renamed ONLY for manual renames (OSC title writes land in
	// the tab's label and fire pane_facts instead — verified). So any matching
	// rename event is user intent and gets manual priority.
	let eventsProc: ChildProcess | null = null;
	let ourTabId: string | null = null;
	let eventsBuf = "";
	let selfRename: string | null = null; // tab rename we issued ourselves (ignore the echoed event)
	let tabNameOurs = false; // tab's name field was last written by this extension (not the user)

	function resolveTabId(): string | null {
		const pane = Number(process.env["TTY7_PANE"]);
		if (!Number.isFinite(pane)) return null;
		try {
			const out = spawnSync(TTY7_EXE, ["tab", "ls", "--json"], { encoding: "utf8", timeout: 5000 });
			const tabs = (JSON.parse(out.stdout ?? "{}") as { tabs?: Array<{ id: string; panes: number[] }> }).tabs ?? [];
			return tabs.find((t) => t.panes.includes(pane))?.id ?? null;
		} catch {
			return null;
		}
	}

	function stopEvents() {
		eventsProc?.kill();
		eventsProc = null;
		eventsBuf = "";
	}

	let lastCtx: ExtensionContext | null = null; // for ui.notify outside event handlers

	function startEvents(pi: ExtensionAPI) {
		stopEvents();
		const newTabId = resolveTabId();
		if (newTabId !== ourTabId) appliedTabName = null; // new tab → its name field state is unknown
		ourTabId = newTabId;
		try {
			eventsProc = spawn(TTY7_EXE, ["events", "--json"], { stdio: ["ignore", "pipe", "ignore"] });
		} catch {
			return; // silent: reverse sync is best-effort
		}
		eventsProc.stdout!.on("data", (chunk: Buffer) => {
			eventsBuf += chunk.toString();
			let nl: number;
			while ((nl = eventsBuf.indexOf("\n")) >= 0) {
				const line = eventsBuf.slice(0, nl).trim();
				eventsBuf = eventsBuf.slice(nl + 1);
				if (!line) continue;
				let renamed: { tab?: string; name?: string } | undefined;
				try {
					const evt = JSON.parse(line) as { layout?: { delta?: { tab_renamed?: { tab: string; name: string } } } };
					renamed = evt.layout?.delta?.tab_renamed;
				} catch {
					continue; // partial/malformed line
				}
				if (!renamed || typeof renamed.name !== "string") continue;
				// Echo of our own forward sync → not user intent.
				if (selfRename !== null && renamed.name === selfRename) {
					selfRename = null;
					continue;
				}
				selfRename = null;
				// Lazy re-resolve: session may have moved to another tab (resume etc.).
				if (ourTabId !== renamed.tab) {
					ourTabId = resolveTabId();
					if (ourTabId !== renamed.tab) continue;
				}
				const name = renamed.name.trim();
				if (!name) continue; // cleared/whitespace rename → ignore
				if (pi.getSessionName() === name) continue; // no-op rename
				manual = true; // user intent: auto-naming never overrides from here
				tabNameOurs = false; // the user owns the tab name now
				appliedTabName = name;
				suppressInfo = true;
				pi.setSessionName(name);
				applyName(name);
				lastCtx?.ui.notify(`Session name set: ${name}`, "info");
			}
		});
		eventsProc.on("exit", () => {
			eventsProc = null;
		});
	}

	// pi core rewrites the title after extension handlers on session_info_changed;
	// a one-tick defer makes our write the final one.
	let pendingTitle: ReturnType<typeof setTimeout> | null = null;
	function setTitleSoon(title: string) {
		if (pendingTitle) clearTimeout(pendingTitle);
		pendingTitle = setTimeout(() => {
			pendingTitle = null;
			try {
				process.stdout.write(`\x1B]0;${title}\x07`);
			} catch {}
		}, 0);
	}

	let appliedTabName: string | null = null; // name currently on the tab's name field

	// Forward sync: keep the tab's `name` field equal to the session name via
	// `tab rename`. The OSC title only updates the tab's `label`, which the GUI
	// hides once a user rename has set `name` (verified) — so session-side
	// renames must go through the CLI to stay visible. tab rename accepts the
	// tab UUID directly.
	function tabRename(name: string) {
		if (name === appliedTabName) return;
		if (!ourTabId) ourTabId = resolveTabId();
		if (!ourTabId) return;
		appliedTabName = name;
		tabNameOurs = true;
		selfRename = name; // ignore the tab_renamed event this will echo back
		try {
			spawn(TTY7_EXE, ["tab", "rename", ourTabId, name], { stdio: "ignore" }).on("error", () => {});
		} catch {}
	}

	function applyName(name: string | null) {
		if (name) {
			lastCustom = name;
			setTitleSoon(name);
			tabRename(name);
		} else if (lastCustom !== null) {
			lastCustom = null;
			setTitleSoon("");
			// Reset the tab name too — but only if we wrote it; a user-chosen
			// tab name survives the session ("退出 pi → Tab 回落默认" only
			// applies to names the extension set).
			if (tabNameOurs && ourTabId) {
				tabNameOurs = false;
				appliedTabName = null;
				try {
					spawn(TTY7_EXE, ["tab", "rename", ourTabId, ""], { stdio: "ignore" }).on("error", () => {});
				} catch {}
			}
		}
	}

	function tryName(ctx: ExtensionContext, latestPrompt?: string) {
		if (manual || pi.getSessionName() || inFlight || !ctx.model) return;
		const messages = historyUserMessages(ctx);
		if (latestPrompt) messages.push(latestPrompt);
		if (messages.length === 0) return;
		let context = messages.join("\n---\n");
		if (context.length > HISTORY_CHARS) context = context.slice(-HISTORY_CHARS);
		const myGen = gen;
		const model = ctx.model;
		inFlight = true;
		// Fire-and-forget: naming must not delay the user's turn.
		void (async () => {
			let name = "";
			try {
				const request = ctx.modelRegistry.complete(
					model,
					{
						messages: [
							{
								role: "user" as const,
								content: [{ type: "text" as const, text: `${NAME_PROMPT}${context}\n</user-messages>` }],
								timestamp: Date.now(),
							},
						],
					},
					{ maxTokens: MAX_TOKENS, cacheRetention: "none", sessionId: crypto.randomUUID() },
				);
				const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), NAME_TIMEOUT_MS));
				const response = await Promise.race([request, timeout]);
				if (!response) return; // timed out; next turn retries
				const text = response.content
					.filter((c): c is { type: "text"; text: string } => c.type === "text")
					.map((c) => c.text)
					.join(" ");
				name = sanitizeTitle(text);
			} catch {
				// Silent: next turn retries automatically.
				return;
			} finally {
				inFlight = false;
			}
			// Session may have been switched/quit while the request was in flight,
			// or the user may have named it manually meanwhile.
			if (!name || myGen !== gen || manual || pi.getSessionName()) return;
			suppressInfo = true;
			pi.setSessionName(name);
			applyName(name);
		})();
	}

	pi.on("session_start", (event, ctx) => {
		if (isSubagent(ctx)) return; // child agent process: the tab belongs to the main session
		lastCtx = ctx;
		gen++;
		manual = false;
		suppressInfo = false;
		inFlight = false;
		// /new is a full new cycle: the tab always falls back to the default, even
		// when the current name came from a manual tty7 rename (reverse sync).
		if (event.reason === "new" && appliedTabName) {
			tabRename("");
			tabNameOurs = false;
		} else if (tabNameOurs && ourTabId) {
			// Switching sessions: a tab name we wrote for the previous session no
			// longer applies; clear it before the new session's name lands.
			tabNameOurs = false;
			appliedTabName = null;
			try {
				spawn(TTY7_EXE, ["tab", "rename", ourTabId, ""], { stdio: "ignore" }).on("error", () => {});
			} catch {}
		}
		const storedName = pi.getSessionName();
		// A leaked subagent name ("type#hex8") may have been persisted into this
		// session's file by pi-subagents; never display or trust it.
		applyName(storedName && !SUBAGENT_NAME.test(storedName) ? storedName : null);
		startEvents(pi);
		// Resumed a session that was never named → name it from its history now.
		if (event.reason === "resume" || event.reason === "fork") tryName(ctx);
	});

	pi.on("session_info_changed", (event, ctx) => {
		// Subagents run in-process and setSessionName("type#hex8") on their child
		// session; that event reaches us here and would clobber the main session's
		// tab name (and flip manual=true, killing auto-naming). Ignore both the
		// child-context delivery and the leaked name pattern itself.
		if (isSubagent(ctx) || SUBAGENT_NAME.test(event.name ?? "")) return;
		if (suppressInfo) {
			suppressInfo = false;
			return;
		}
		manual = event.name !== undefined;
		if (event.name) applyName(event.name);
	});

	pi.on("session_shutdown", (event, ctx) => {
		if (isSubagent(ctx)) return; // never touched the tab, nothing to reset
		gen++;
		stopEvents();
		applyName(null);
	});

	pi.on("before_agent_start", (event, ctx) => {
		if (isSubagent(ctx)) return;
		// First prompt of an unnamed session, or a retry after a failed attempt.
		tryName(ctx, event.prompt);
	});
}
