import assert from "node:assert/strict";
import { sanitizeTitle } from "../extensions/tab-namer.ts";

const cases: Array<[string, string]> = [
	["调试 tty7 标签同步功能", "调试 tty7 标签同步功能"],
	['  "重构数据库迁移逻辑"。\n', "重构数据库迁移逻辑"],
	["《修复登录页的空白问题》", "修复登录页的空白问题"],
	["一行\n\n两行", "一行"],
	["a".repeat(30), "a".repeat(20)],
	["   ", ""],
];

let failed = 0;
for (const [input, want] of cases) {
	const got = sanitizeTitle(input);
	try {
		assert.equal(got, want);
	} catch {
		failed++;
		console.error(`FAIL: ${JSON.stringify(input)} -> ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
	}
}

if (failed) {
	console.error(`${failed}/${cases.length} failed`);
	process.exit(1);
}
console.log(`all ${cases.length} ok`);
