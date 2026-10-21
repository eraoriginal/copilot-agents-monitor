import assert from "node:assert/strict";
import { test } from "node:test";
import { isColdCall, sessionIndicators, TARGETS } from "../public/indicators.js";
import { createStore, deriveSession, ingest } from "../public/model.js";

const CONVERSATION = "6d0a1c33-5c2e-4f6e-9a35-0d8c1b1f2e77";
const T0 = 1_792_273_390_000;
let counter = 0;

function span(name, parentSpanId, startS, endS, attributes = {}, spanId = `s${++counter}`) {
	return {
		traceId: "t1",
		spanId,
		parentSpanId,
		name,
		start: T0 + startS * 1000,
		end: T0 + endS * 1000,
		attributes: { "gen_ai.conversation.id": CONVERSATION, ...attributes },
		status: { code: 0 },
	};
}

/** An LLM call: `input` tokens in all, of which `read` came from the cache and `written` went to it. */
const chat = (parent, startS, { input, read = 0, written = 0, credits = 1, initiator = "agent" }) =>
	span("chat claude-opus-5.5", parent, startS, startS + 2, {
		"gen_ai.operation.name": "chat",
		"gen_ai.response.model": "claude-opus-5.5",
		"gen_ai.usage.input_tokens": input,
		"gen_ai.usage.output_tokens": 100,
		"gen_ai.usage.cache_read.input_tokens": read,
		"gen_ai.usage.cache_write.input_tokens": written,
		"github.copilot.nano_aiu": credits * 1e9,
		"github.copilot.initiator": initiator,
	});

const agentSpan = (name, spanId, parent, startS, endS) =>
	span(`invoke_agent ${name}`, parent, startS, endS, { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": name }, spanId);

function viewOf(spans) {
	const store = createStore();
	for (const record of spans) ingest(store, { kind: "span", time: record.end, data: record });
	return deriveSession(store.sessions.get(CONVERSATION), { now: T0 + 4_000_000 });
}

test("a call that writes most of a large prompt to the cache found it cold", () => {
	assert.equal(isColdCall({ input: 200_000, cacheWrite: 199_000 }), true);
	assert.equal(isColdCall({ input: 200_000, cacheWrite: 3_000 }), false);
	// A small prompt costs little whatever the cache did.
	assert.equal(isColdCall({ input: 20_000, cacheWrite: 20_000 }), false);
});

test("wake-ups are the root agent's cold calls after its first, across its turns", () => {
	const task = span("execute_tool task", "root1", 3, 4, {
		"gen_ai.operation.name": "execute_tool",
		"gen_ai.tool.name": "task",
		"gen_ai.tool.call.id": "call_task",
		"gen_ai.agent.name": "conductor",
	});
	const view = viewOf([
		agentSpan("conductor", "root1", null, 0, 1200),
		// The session's first call writes everything: nothing could be cached before it.
		chat("root1", 0, { input: 40_000, written: 40_000, credits: 20, initiator: "user" }),
		chat("root1", 10, { input: 60_000, read: 58_000, written: 2_000, credits: 2 }),
		task,
		agentSpan("implementer", "sub", task.spanId, 4, 1000),
		chat("sub", 5, { input: 10_000, written: 10_000 }),
		chat("sub", 900, { input: 300_000, read: 299_000, written: 1_000, credits: 3 }),
		// Back from a subagent that ran for 20 minutes: the cache had expired.
		chat("root1", 1100, { input: 150_000, written: 149_000, credits: 75 }),
		// The next turn, after the user took ten minutes to answer.
		agentSpan("conductor", "root2", null, 1800, 1900),
		chat("root2", 1800, { input: 160_000, written: 159_000, credits: 80, initiator: "user" }),
		chat("root2", 1810, { input: 161_000, read: 160_000, written: 1_000, credits: 4 }),
	]);

	const k = sessionIndicators(view);
	assert.equal(k.wakeUps.count, 2);
	assert.equal(k.wakeUps.tokens, 308_000);
	assert.equal(k.wakeUps.average, 154_000);
	assert.equal(k.wakeUps.largest, 159_000);
	assert.equal(k.wakeUps.credits, 155);
	assert.equal(k.wakeUps.over, true);
	assert.equal(k.credits, view.totals.credits);
});

test("the largest context is the largest prompt one agent run sent", () => {
	const task = span("execute_tool task", "root", 1, 2, {
		"gen_ai.operation.name": "execute_tool",
		"gen_ai.tool.name": "task",
		"gen_ai.tool.call.id": "call_t",
		"gen_ai.agent.name": "conductor",
	});
	const view = viewOf([
		agentSpan("conductor", "root", null, 0, 100),
		chat("root", 0, { input: 40_000 }),
		task,
		agentSpan("implementer", "impl", task.spanId, 2, 90),
		chat("impl", 3, { input: 9_000 }),
		chat("impl", 50, { input: 420_000, read: 419_000 }),
	]);
	const k = sessionIndicators(view);
	assert.equal(k.context.max, 420_000);
	assert.equal(k.context.agent, "implementer");
	assert.deepEqual(
		k.context.runs.map((run) => [run.name, run.max]),
		[
			["implementer", 420_000],
			["conductor", 40_000],
		],
	);
	assert.equal(k.context.over, k.context.max > TARGETS.contextTokens);
	assert.equal(k.wakeUps.count, 0);
	assert.equal(k.wakeUps.over, false);
});

test("the hooks' share is read against its target, and absent without a journal", () => {
	const view = viewOf([agentSpan("conductor", "root", null, 0, 10), chat("root", 0, { input: 1000 })]);
	assert.equal(sessionIndicators(view).hooks, null);
	const k = sessionIndicators(view, { hookMs: 12_000, workMs: 60_000, share: 0.2, byType: {} });
	assert.equal(k.hooks.share, 0.2);
	assert.equal(k.hooks.over, true);
	assert.equal(sessionIndicators(view, { hookMs: 600, workMs: 60_000, share: 0.01, byType: {} }).hooks.over, false);
});
