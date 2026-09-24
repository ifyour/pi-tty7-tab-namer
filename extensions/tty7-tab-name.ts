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
 *
 * Title channel note: pi core also writes the title (`π - name - cwd`) in its
 * own session_info_changed handler, which runs AFTER extension handlers. All
 * our title writes are therefore deferred by one tick to land last, and we
 * write exactly `{name}`.
 */
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const NAME_PROMPT =
	"根据下面的用户消息记录，为这个会话起一个简短标题：不超过10个字，概括整个会话的主要意图，中文，不加引号、句号或任何前后缀，直接输出标题本身。\n\n<user-messages>\n";
const MAX_TOKENS = 512;
const NAME_TIMEOUT_MS = 20_000;
const HISTORY_MESSAGES = 10;
const HISTORY_CHARS = 2000;

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

	let gen = 0; // bumped on every session transition; in-flight naming must match
	let manual = false; // a name arrived that we did not set
	let suppressInfo = false; // the next session_info_changed is our own setSessionName
	let inFlight = false;
	let lastCustom: string | null = null; // title we manage; null = leave terminal default

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

	function applyName(name: string | null) {
		if (name) {
			lastCustom = name;
			setTitleSoon(name);
		} else if (lastCustom !== null) {
			lastCustom = null;
			setTitleSoon("");
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
		gen++;
		manual = false;
		suppressInfo = false;
		inFlight = false;
		applyName(pi.getSessionName() ?? null);
		// Resumed a session that was never named → name it from its history now.
		if (event.reason === "resume" || event.reason === "fork") tryName(ctx);
	});

	pi.on("session_info_changed", (event) => {
		if (suppressInfo) {
			suppressInfo = false;
			return;
		}
		manual = event.name !== undefined;
		if (event.name) applyName(event.name);
	});

	pi.on("session_shutdown", () => {
		gen++;
		applyName(null);
	});

	pi.on("before_agent_start", (event, ctx) => {
		// First prompt of an unnamed session, or a retry after a failed attempt.
		tryName(ctx, event.prompt);
	});
}
