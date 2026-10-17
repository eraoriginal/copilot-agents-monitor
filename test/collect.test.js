import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { clip } from "../src/clip.js";
import { dayFile } from "../src/config.js";
import { parseLines, purgeOldDays, tailDayFile } from "../src/store.js";

const HOOK = fileURLToPath(new URL("../src/hook.js", import.meta.url));

function tempDir(t) {
	const dir = mkdtempSync(join(tmpdir(), "agent-monitor-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

test("the hook appends the event, prints nothing and exits 0", (t) => {
	const dir = tempDir(t);
	const event = { hook_event_name: "PreToolUse", tool_name: "read_file", tool_use_id: "call_1" };
	const result = spawnSync(process.execPath, [HOOK], {
		input: JSON.stringify(event),
		env: { ...process.env, AGENT_MONITOR_HOME: dir },
		encoding: "utf8",
	});
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
	const [record] = parseLines(readFileSync(dayFile(dir, "hooks"), "utf8"));
	assert.deepEqual(record.event, event);
});

test("the hook exits 0 even when the data directory cannot be written", () => {
	const result = spawnSync(process.execPath, [HOOK], {
		input: "{}",
		env: { ...process.env, AGENT_MONITOR_HOME: join(HOOK, "not-a-directory") },
		encoding: "utf8",
	});
	assert.equal(result.status, 0);
	assert.equal(result.stdout, "");
});

test("clip caps long strings and keeps the shape", () => {
	const clipped = clip({ content: "x".repeat(5000), list: [1, 2] });
	assert.equal(clipped.content.startsWith("x".repeat(2000)), true);
	assert.match(clipped.content, /3000 more chars/);
	assert.deepEqual(clipped.list, [1, 2]);
});

test("tailDayFile reads what is appended, and waits for a line to be complete", async (t) => {
	const dir = tempDir(t);
	const file = dayFile(dir, "hooks");
	writeFileSync(file, `${JSON.stringify({ old: true })}\n`);
	const seen = [];
	const stop = tailDayFile(dir, "hooks", (record) => seen.push(record), { intervalMs: 10 });
	t.after(stop);
	appendFileSync(file, `${JSON.stringify({ n: 1 })}\n{"n":`);
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.deepEqual(seen, [{ n: 1 }]);
	appendFileSync(file, "2}\n");
	await new Promise((resolve) => setTimeout(resolve, 60));
	assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);
});

test("purgeOldDays deletes only this tool's files older than the retention", (t) => {
	const dir = tempDir(t);
	for (const name of ["hooks-2026-01-01.jsonl", "spans-2026-10-16.jsonl", "notes.txt"]) {
		writeFileSync(join(dir, name), "");
	}
	const removed = purgeOldDays(dir, 14, new Date(2026, 9, 17));
	assert.deepEqual(removed, ["hooks-2026-01-01.jsonl"]);
});
