import assert from "node:assert/strict";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJournalReader, journalPath } from "../src/copilotJournal.js";

const SESSION = "d0e2b379-1561-4acb-ab28-8126a2bbb375";
const T0 = Date.parse("2026-10-20T08:35:00.000Z");
const at = (ms) => new Date(T0 + ms).toISOString();

/** One line of Copilot's journal. */
const line = (type, ms, data = {}, agentId = undefined) =>
	`${JSON.stringify({ type, data, ...(agentId ? { agentId } : {}), id: `e${ms}`, timestamp: at(ms) })}\n`;

function homeWith(t, lines) {
	const home = mkdtempSync(join(tmpdir(), "agent-monitor-copilot-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	const dir = join(home, "session-state", SESSION);
	mkdirSync(dir, { recursive: true });
	writeFileSync(join(dir, "events.jsonl"), lines.join(""));
	return { home, file: join(dir, "events.jsonl") };
}

test("the hooks' share is their time over the agents' turns, each agent on its own", (t) => {
	const { home } = homeWith(t, [
		line("session.start", 0),
		// The main agent: one turn of 10 s with a 2 s hook in it.
		line("assistant.turn_start", 0),
		line("hook.start", 1000, { hookInvocationId: "h1", hookType: "preToolUse" }),
		line("hook.end", 3000, { hookInvocationId: "h1", hookType: "preToolUse", success: true }),
		line("assistant.turn_end", 10_000),
		// A subagent, at the same time: one turn of 10 s, two hooks that overlap by 1 s.
		line("assistant.turn_start", 2000, {}, "sub-1"),
		line("hook.start", 3000, { hookInvocationId: "h2", hookType: "postToolUse" }, "sub-1"),
		line("hook.start", 4000, { hookInvocationId: "h3", hookType: "postToolUse" }, "sub-1"),
		line("hook.end", 5000, { hookInvocationId: "h2", hookType: "postToolUse" }, "sub-1"),
		line("hook.end", 6000, { hookInvocationId: "h3", hookType: "postToolUse" }, "sub-1"),
		line("assistant.turn_end", 12_000, {}, "sub-1"),
		// Waiting for the user is not working time.
		line("assistant.turn_start", 600_000),
		line("assistant.turn_end", 605_000),
	]);
	const hooks = createJournalReader({ env: { COPILOT_HOME: home } }).hooksOf(SESSION);
	assert.equal(hooks.workMs, 25_000);
	// 2 s for the main agent; 3 s for the subagent, its overlapping second counted once.
	assert.equal(hooks.hookMs, 5000);
	assert.equal(hooks.share, 0.2);
	assert.deepEqual(hooks.byType, { preToolUse: { count: 1, ms: 2000 }, postToolUse: { count: 2, ms: 4000 } });
});

test("a growing journal is read from where the last read stopped", (t) => {
	const { home, file } = homeWith(t, [
		line("assistant.turn_start", 0),
		line("hook.start", 0, { hookInvocationId: "h1", hookType: "preToolUse" }),
	]);
	const reader = createJournalReader({ env: { COPILOT_HOME: home } });
	// A turn still open and a hook still running: nothing to report yet.
	assert.equal(reader.hooksOf(SESSION), null);
	// The next line arrives in two writes, cut in the middle of a character.
	const end = line("hook.end", 1000, { hookInvocationId: "h1", hookType: "préToolUse" });
	const bytes = Buffer.from(end, "utf8");
	const cut = bytes.indexOf(Buffer.from("é", "utf8")) + 1;
	appendFileSync(file, bytes.subarray(0, cut));
	assert.equal(reader.hooksOf(SESSION), null);
	appendFileSync(file, bytes.subarray(cut));
	appendFileSync(file, line("assistant.turn_end", 4000));
	const hooks = reader.hooksOf(SESSION);
	assert.equal(hooks.hookMs, 1000);
	assert.equal(hooks.workMs, 4000);
	assert.equal(hooks.share, 0.25);
});

test("a session with no journal on this machine has no hooks' share", (t) => {
	const home = mkdtempSync(join(tmpdir(), "agent-monitor-copilot-"));
	t.after(() => rmSync(home, { recursive: true, force: true }));
	assert.equal(createJournalReader({ env: { COPILOT_HOME: home } }).hooksOf(SESSION), null);
});

test("a session ID never names a path outside the journals", () => {
	const env = { COPILOT_HOME: "C:/copilot" };
	assert.equal(journalPath("../../Windows/win.ini", env), null);
	assert.equal(journalPath("..\\secrets", env), null);
	assert.equal(journalPath("C:/Windows", env), null);
	assert.equal(journalPath("", env), null);
	assert.match(journalPath(SESSION, env), /session-state[\\/]d0e2b379-1561-4acb-ab28-8126a2bbb375[\\/]events\.jsonl$/);
});
