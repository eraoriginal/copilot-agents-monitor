import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseAgentFile } from "../public/routing.js";
import { createHistory } from "../src/history.js";
import { parseLines } from "../src/store.js";

const T0 = Date.now() - 600_000;

function span(name, parent, spanId, attributes) {
	return {
		traceId: "t",
		spanId,
		parentSpanId: parent,
		name,
		start: T0,
		end: T0 + 5000,
		attributes: { "gen_ai.conversation.id": "session-1", ...attributes },
		status: { code: 0 },
	};
}

const SPANS = [
	span("invoke_agent conductor", null, "root", { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "conductor" }),
	span("chat claude-opus-5.5", "root", "c1", {
		"gen_ai.operation.name": "chat",
		"gen_ai.response.model": "claude-opus-5.5",
		"gen_ai.usage.input_tokens": 1000,
		"gen_ai.usage.output_tokens": 100,
		"github.copilot.nano_aiu": 2e9,
		"github.copilot.initiator": "user",
	}),
];

test("a quiet session is summarized with its workspace, branch, ticket and cost, and keeps them", (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "agent-monitor-history-"));
	t.after(() => rmSync(dataDir, { recursive: true, force: true }));
	const workspace = {
		path: "C:/repo",
		name: "repo",
		agents: [parseAgentFile("---\nname: conductor\nmodel: ['Claude Opus 5.5 (copilot)']\n---\n")],
		branch: "feat/FRCLM-46-edit",
		branchHistory: [{ since: T0 - 1000, branch: "feat/FRCLM-46-edit" }],
	};
	const workspaces = { list: () => [workspace] };
	const pricing = { usdPerCredit: 0.01, models: {} };

	const history = createHistory({ dataDir, workspaces, pricing });
	t.after(() => history.stop());
	for (const record of SPANS) history.ingest({ kind: "span", time: record.end, data: record });
	history.flushAll();

	const [summary] = history.list();
	assert.equal(summary.ticket, "FRCLM-46");
	assert.equal(summary.workspaceName, "repo");
	assert.equal(summary.totals.credits, 2);
	assert.equal(summary.byAgent.conductor.credits, 2);
	assert.equal(summary.branchGuessed, false);

	// The branch moves on; the session keeps the ticket it ran for.
	workspace.branch = "main";
	workspace.branchHistory = [{ since: T0 - 2000, branch: "main" }];
	history.ingest({
		kind: "span",
		time: T0 + 6000,
		data: span("execute_tool view", "root", "v1", { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "view" }),
	});
	history.flushAll();
	assert.equal(history.list()[0].ticket, "FRCLM-46");

	// A second instance reads what the first one wrote.
	const reloaded = createHistory({ dataDir, workspaces, pricing });
	t.after(() => reloaded.stop());
	assert.equal(reloaded.list()[0].totals.tools, 1);
	assert.equal(parseLines(readFileSync(join(dataDir, "sessions.jsonl"), "utf8")).length, 2);
});

test("a summary keeps the session's indicators, the hooks' share from the journal included", (t) => {
	const dataDir = mkdtempSync(join(tmpdir(), "agent-monitor-history-"));
	t.after(() => rmSync(dataDir, { recursive: true, force: true }));
	const workspaces = { list: () => [] };
	const pricing = { usdPerCredit: 0.01, models: {} };
	const asked = [];
	const journal = {
		hooksOf(id) {
			asked.push(id);
			return { hookMs: 6000, workMs: 60_000, share: 0.1, byType: {} };
		},
	};

	const history = createHistory({ dataDir, workspaces, pricing, journal });
	t.after(() => history.stop());
	for (const record of SPANS) history.ingest({ kind: "span", time: record.end, data: record });
	history.flushAll();

	const [summary] = history.list();
	assert.deepEqual(asked, ["session-1"]);
	assert.deepEqual(summary.indicators.wakeUps, { count: 0, average: 0, credits: 0 });
	assert.deepEqual(summary.indicators.context, { max: 1000, agent: "conductor" });
	assert.deepEqual(summary.indicators.hooks, { share: 0.1, hookMs: 6000, workMs: 60_000 });
});
