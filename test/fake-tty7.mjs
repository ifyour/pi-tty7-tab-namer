#!/usr/bin/env node
// Fake tty7 CLI for E2E tests: implements the verbs the extension calls and
// logs every invocation to $E2E_LOG (one line per call, JSON).
//   tab ls --json     → fixed workspace with tab id FAKE-TAB owning pane 116
//   tab rename <id> <name> → logged
//   events --json     → sleeps forever (no events)
import { appendFileSync } from "node:fs";

const log = process.env["E2E_LOG"];
const args = process.argv.slice(2);
if (log) {
	try {
		appendFileSync(log, JSON.stringify(args) + "\n");
	} catch {}
}

const cmd = args[0];
if (cmd === "tab" && args[1] === "ls") {
	process.stdout.write(
		JSON.stringify({
			workspace: "00000000-0000-0000-0000-000000000000",
			tabs: [{ ordinal: 1, id: "FAKE-TAB", name: null, label: "", agent: "", group: "", panes: [116] }],
		}),
	);
} else if (cmd === "events") {
	// Keep the pipe open like the real CLI; extension kills us at shutdown.
	setInterval(() => {}, 1 << 30);
} // tab rename / anything else: exit silently like the real CLI
