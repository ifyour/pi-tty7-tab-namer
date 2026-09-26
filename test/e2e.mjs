#!/usr/bin/env node
// E2E: run real pi with the extension against fake-tty7 and a local fake
// OpenAI-compatible model endpoint, then assert the tab was renamed and the
// OSC title was written. Fully offline, no real API key.
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname;
const MODEL_ID = "fake-model";

// Minimal OpenAI-completions endpoint: streams a fixed assistant reply.
// If the request looks like the extension's naming prompt, reply with a title.
const server = createServer((req, res) => {
	let body = "";
	req.on("data", (c) => (body += c));
	req.on("end", () => {
		const naming = body.includes("<user-messages>");
		const text = naming ? "测试会话名" : "ok";
		res.writeHead(200, { "content-type": "text/event-stream" });
		const chunk = (delta, extra = {}) =>
			`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ index: 0, delta, ...extra }] })}\n\n`;
		res.write(chunk({ role: "assistant" }));
		res.write(chunk({ content: text }));
		res.write(chunk({}, { finish_reason: "stop" }));
		res.write(`data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
		res.write("data: [DONE]\n\n");
		res.end();
	});
});
server.listen(0, "127.0.0.1");
await new Promise((r) => server.on("listening", r));
const PORT = server.address().port;

const tmp = mkdtempSync(join(tmpdir(), "tab-namer-e2e-"));
// models.json via a redirected agent dir points pi at the fake endpoint.
const agentDir = join(tmp, "agent");
mkdirSync(agentDir);
writeFileSync(
	join(agentDir, "models.json"),
	JSON.stringify({
		providers: { openai: { baseUrl: `http://127.0.0.1:${PORT}/v1`, api: "openai-completions", apiKey: "dummy", models: [{ id: MODEL_ID, input: ["text"] }] } },
	}),
);

async function run(extraArgs, logFile) {
	const res = await new Promise((resolve) => {
		const child = spawn(
			"pi",
			[
				"-e", join(ROOT, "extensions/tab-namer.ts"),
				"-p", "--no-session", "--no-extensions",
				"--provider", "openai", "--model", MODEL_ID,
				...extraArgs,
			],
			{
				cwd: tmp,
				// Capture both streams so OSC assertions can scan them.
				stdio: ["ignore", "pipe", "pipe"],
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: agentDir,
					TTY7: "1",
					TTY7_PANE: "116",
					TTY7_CLI: join(ROOT, "test/fake-tty7.mjs"),
					E2E_LOG: logFile,
				},
			},
		);
		let stdout = "";
		let stderr = "";
		const t = setTimeout(() => child.kill("SIGKILL"), 120_000);
		child.stdout.on("data", (c) => (stdout += c));
		child.stderr.on("data", (c) => (stderr += c));
		child.on("close", (code) => {
			clearTimeout(t);
			resolve({ status: code, stdout, stderr });
		});
	});
	if (res.status !== 0) {
		throw new Error(`pi failed: exit ${res.status}\nstderr: ${res.stderr}`);
	}
	return res;
}

const calls = (file) => readFileSync(file, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const renames = (file) => calls(file).filter((a) => a[0] === "tab" && a[1] === "rename");

// Case 1: session name set at startup (--name) → must reach the tab, no LLM.
const log1 = join(tmp, "calls1.log");
const r1 = await run(["--name", "契约测试名", "回复ok即可"], log1);
assert.ok(renames(log1).some((a) => a[2] === "FAKE-TAB" && a[3] === "契约测试名"), `rename not called: ${JSON.stringify(renames(log1))}`);
const allOut = r1.stdout + r1.stderr;
assert.ok(allOut.includes("\x1B]0;契约测试名\x07"), "OSC title not written");
assert.ok(allOut.includes("\x1B]0;\x07"), "OSC title not reset on shutdown");

// Case 2: unnamed session → extension calls the (fake) model, names the
// session, and pushes the name to the tab.
const log2 = join(tmp, "calls2.log");
await run(["回复ok即可"], log2);
assert.ok(
	renames(log2).some((a) => a[2] === "FAKE-TAB" && a[3] === "测试会话名"),
	`auto-naming rename not called: ${JSON.stringify(renames(log2))}`,
);

server.close();
rmSync(tmp, { recursive: true, force: true });
console.log("e2e: ok (3 cases)");
