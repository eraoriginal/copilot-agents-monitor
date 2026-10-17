import assert from "node:assert/strict";
import { test } from "node:test";
import { createStore, deriveSession, ingest } from "../public/model.js";
import { childrenOf, launchOf, waveStarts } from "../public/tree.js";

const T0 = 1_792_273_390_000;
let n = 0;
function span(name, parent, s, e, attributes = {}, spanId = `n${++n}`) {
	return {
		traceId: "t",
		spanId,
		parentSpanId: parent,
		name,
		start: T0 + s * 1000,
		end: T0 + e * 1000,
		attributes: { "gen_ai.conversation.id": "c", ...attributes },
		status: { code: 0 },
	};
}
const agentSpan = (name, parent, s, e, id) =>
	span(`invoke_agent ${name}`, parent, s, e, { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": name }, id);
const task = (parent, agent, s, e) =>
	span("execute_tool task", parent, s, e, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "task", "gen_ai.agent.name": agent });
const chat = (parent, s, e, initiator) =>
	span("chat gpt-6-luna", parent, s, e, {
		"gen_ai.operation.name": "chat",
		"gen_ai.response.model": "gpt-6-luna",
		"gen_ai.usage.input_tokens": 100,
		"gen_ai.usage.output_tokens": 10,
		"github.copilot.initiator": initiator,
	});

/** lead → planner → (finder, checker); lead → reviewer, as the agent host exports them. */
function nested() {
	const taPlanner = task("lead", "lead", 2, 14);
	const taFinder = task("planner", "planner", 4, 10);
	const taChecker = task("planner", "planner", 4, 12);
	const taReviewer = task("lead", "lead", 15, 22);
	const store = createStore();
	for (const record of [
		chat("lead", 0, 2, "user"),
		taPlanner,
		chat("planner", 2.5, 4, "sub-agent"),
		taFinder,
		chat("finder", 4.5, 6, "sub-agent"),
		agentSpan("finder", taFinder.spanId, 4, 10, "finder"),
		taChecker,
		chat("checker", 4.6, 7, "sub-agent"),
		agentSpan("checker", taChecker.spanId, 4, 12, "checker"),
		agentSpan("planner", taPlanner.spanId, 2, 14, "planner"),
		taReviewer,
		chat("reviewer", 15.5, 18, "sub-agent"),
		agentSpan("reviewer", taReviewer.spanId, 15, 22, "reviewer"),
		agentSpan("lead", null, 0, 24, "lead"),
	]) {
		ingest(store, { kind: "span", time: record.end, data: record });
	}
	return deriveSession(store.sessions.get("c"), { now: T0 + 30_000 });
}

test("an agent launched by a subagent hangs under that subagent, not under the root", () => {
	const view = nested();
	const lead = view.agents.get("lead");
	const planner = view.agents.get("planner");
	assert.deepEqual(childrenOf(view, lead).map((agent) => agent.name), ["planner", "reviewer"]);
	// Both start at the same instant: the order between them is not meaningful.
	assert.deepEqual(childrenOf(view, planner).map((agent) => agent.name).sort(), ["checker", "finder"]);
	assert.equal(view.agents.get("finder").parentKey, "planner");
});

test("a launched agent shows who launched it and how far into that agent's own run", () => {
	const view = nested();
	const planner = view.agents.get("planner");
	const finder = view.agents.get("finder");
	assert.deepEqual(launchOf(planner, finder), { launcher: "planner", offset: "+2.0s" });
	assert.deepEqual(launchOf(view.agents.get("lead"), planner), { launcher: "lead", offset: "+2.0s" });
	assert.deepEqual(launchOf(view.agents.get("lead"), view.agents.get("reviewer")), { launcher: "lead", offset: "+15.0s" });
});

test("an agent with no known launcher shows none", () => {
	const view = nested();
	assert.deepEqual(launchOf(null, view.agents.get("lead")), { launcher: null, offset: "" });
	assert.deepEqual(launchOf({ virtual: true }, view.agents.get("lead")), { launcher: null, offset: "" });
});

// Seconds into the run, as milliseconds: the code treats 50 ms as clock jitter.
const kid = (startS, endS) => ({ start: startS * 1000, end: endS == null ? null : endS * 1000, done: endS != null });

test("agents that overlap form one wave; one that starts after they finish opens the next", () => {
	const kids = [kid(0, 8), kid(0, 11), kid(0, 12), kid(12, 20), kid(12, 15), kid(30, 40)];
	assert.deepEqual(waveStarts(kids, 100_000), [false, false, false, true, false, true]);
});

test("a running agent keeps its wave open, so a later start joins it", () => {
	assert.deepEqual(waveStarts([kid(0, null), kid(5, 6)], 10_000), [false, false]);
	assert.deepEqual(waveStarts([kid(0, 3), kid(5, 6)], 10_000), [false, true]);
	assert.deepEqual(waveStarts([], 10_000), []);
});

test("an agent that starts a few milliseconds before the last one ends still opens the next wave", () => {
	const kids = [{ start: 0, end: 5_000, done: true }, { start: 4_980, end: 9_000, done: true }];
	assert.deepEqual(waveStarts(kids, 20_000), [false, true]);
});
