#!/usr/bin/env node
// E2E: run real pi with the extension against fake-tty7, assert the tab was
// renamed and the OSC title was written. Regression guard, no LLM needed.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";

const ROOT = new URL("..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "tab-namer-e2e-"));
const logFile = join(tmp, "calls.log");

function run(extraArgs, logFile) {
	const res = spawnSync(
		"pi",
		[
			"-e", join(ROOT, "extensions/tab-namer.ts"),
			"-p", "--no-session", "--no-extensions",
			...extraArgs,
		],
		{
			cwd: tmp,
			encoding: "utf8",
			timeout: 120_000,
			env: {
				...process.env,
				TTY7: "1",
				TTY7_PANE: "116",
				TTY7_CLI: join(ROOT, "test/fake-tty7.mjs"),
				E2E_LOG: logFile,
			},
		},
	);
	if (res.error || res.status !== 0) {
		throw new Error(`pi failed: ${res.error ?? `exit ${res.status}\nstderr: ${res.stderr}`}`);
	}
	return res;
}

const calls = () => readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l));

// Case 1: session name set at startup (--name) → must reach the tab, no LLM.
const r1 = run(["--name", "契约测试名", "回复ok即可"], logFile);
const renames1 = calls().filter((a) => a[0] === "tab" && a[1] === "rename");
assert.ok(renames1.some((a) => a[2] === "FAKE-TAB" && a[3] === "契约测试名"), `rename not called: ${JSON.stringify(renames1)}`);
const allOut = r1.stdout + r1.stderr;
assert.ok(allOut.includes("\x1B]0;契约测试名\x07"), "OSC title not written");
assert.ok(allOut.includes("\x1B]0;\x07"), "OSC title not reset on shutdown");

// Case 2: unnamed session without a model key → extension must stay silent,
// and never write a subagent-style name or garbage.
const log2 = join(tmp, "calls2.log");
const r2 = run(["回复ok即可"], log2);
const renames2 = readFileSync(log2, "utf8").trim().split("\n").map((l) => JSON.parse(l))
	.filter((a) => a[0] === "tab" && a[1] === "rename" && a[3]);
assert.ok(renames2.length === 0, `unexpected rename without a name source: ${JSON.stringify(renames2)}`);

rmSync(tmp, { recursive: true, force: true });
console.log("e2e: ok (2 cases)");
