import assert from "node:assert/strict";
import { test } from "node:test";
import {
	callUsage,
	createStore,
	deriveSession,
	extractTodos,
	ingest,
	priceFor,
	summarizeArguments,
} from "../public/model.js";

const CONVERSATION = "9e428f18-a5e1-4f78-a0cb-49ffb62d42b5";
const T0 = 1_792_273_390_000;
let counter = 0;

/** A span shaped like those Copilot's agent host exports. */
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

const chat = (parent, startS, endS, extra = {}) =>
	span("chat gpt-6-luna", parent, startS, endS, {
		"gen_ai.operation.name": "chat",
		"gen_ai.response.model": "gpt-6-luna",
		"gen_ai.usage.input_tokens": 1000,
		"gen_ai.usage.output_tokens": 50,
		"gen_ai.usage.cache_read.input_tokens": 400,
		"github.copilot.nano_aiu": 11_040_000,
		...extra,
	});

const tool = (parent, agentName, name, startS, extra = {}) =>
	span(`execute_tool ${name}`, parent, startS, startS + 0.01, {
		"gen_ai.operation.name": "execute_tool",
		"gen_ai.tool.name": name,
		"gen_ai.tool.call.id": `call_${++counter}`,
		"gen_ai.agent.name": agentName,
		...extra,
	});

function storeWith(spans) {
	const store = createStore();
	for (const record of spans) ingest(store, { kind: "span", time: record.end, data: record });
	return store;
}

function sessionOf(spans, options = {}) {
	const store = storeWith(spans);
	return deriveSession(store.sessions.get(CONVERSATION), { now: T0 + 20_000, ...options });
}

test("a subagent belongs to the agent whose task call started it", () => {
	const task = tool("root", "lead", "task", 3);
	const view = sessionOf([
		chat("root", 0, 2, { "github.copilot.initiator": "user" }),
		task,
		chat("sub", 3.5, 5, { "github.copilot.initiator": "sub-agent" }),
		span("invoke_agent finder", task.spanId, 3, 6, { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "finder" }, "sub"),
		span("invoke_agent lead", null, 0, 8, { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "lead" }, "root"),
	]);
	const finder = view.agents.get("sub");
	assert.equal(finder.root, false);
	assert.equal(finder.parentKey, "root");
	assert.equal(finder.status, "done");
	assert.deepEqual(view.agents.get("root").children, ["sub"]);
	assert.equal(view.turns, 1);
});

test("an agent whose own span has not arrived shows as running, named from its tool calls", () => {
	const view = sessionOf([
		chat("root", 0, 2, { "github.copilot.initiator": "user" }),
		chat("pending", 3, 4, { "github.copilot.initiator": "sub-agent" }),
		tool("pending", "checker", "view", 4.2),
	]);
	const checker = view.agents.get("pending");
	assert.equal(checker.name, "checker");
	assert.equal(checker.status, "running");
	assert.equal(checker.parentKey, "root");
	assert.equal(view.live, true);
});

test("subagents that report before their caller hang under a placeholder caller", () => {
	// The agent host exports the root agent's spans when its turn ends.
	const view = sessionOf([
		chat("finder", 3, 4, { "github.copilot.initiator": "sub-agent" }),
		tool("finder", "finder", "view", 4.1),
		chat("checker", 3.1, 4.5, { "github.copilot.initiator": "sub-agent" }),
	]);
	const caller = view.agents.get("pending-root");
	assert.equal(caller.placeholder, true);
	assert.equal(caller.status, "running");
	assert.deepEqual(caller.children.sort(), ["checker", "finder"]);
	assert.equal(view.subagents.every((agent) => agent.parentKey === "pending-root"), true);
});

test("a subagent of a later turn does not hang under an earlier, finished turn", () => {
	const view = sessionOf([
		span("invoke_agent lead", null, 0, 5, { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "lead" }, "turn1"),
		chat("turn1", 0, 1, { "github.copilot.initiator": "user" }),
		chat("late", 7, 8, { "github.copilot.initiator": "sub-agent" }),
	]);
	assert.equal(view.agents.get("late").parentKey, "pending-root");
});

test("an agent silent for two minutes is stalled, not running", () => {
	const view = sessionOf([chat("pending", 0, 1, { "github.copilot.initiator": "user" })], {
		now: T0 + 1000 + 121_000,
	});
	assert.equal(view.agents.get("pending").status, "stalled");
});

test("cost comes from the nano AI credits Copilot reports", () => {
	const usage = callUsage(chat("a", 0, 1), { usdPerCredit: 0.01 });
	assert.equal(usage.credits, 0.01104);
	assert.ok(Math.abs(usage.usd - 0.0001104) < 1e-12);
	assert.equal(usage.estimated, false);
});

test("without nano AI credits, cost is estimated from list prices, cached input at its own rate", () => {
	const pricing = {
		usdPerCredit: 0.01,
		models: { "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } },
	};
	const record = span("chat claude-opus-5.5", "a", 0, 1, {
		"gen_ai.operation.name": "chat",
		"gen_ai.response.model": "claude-opus-5.5",
		"gen_ai.usage.input_tokens": 1_000_000,
		"gen_ai.usage.cache_read.input_tokens": 500_000,
		"gen_ai.usage.output_tokens": 100_000,
	});
	const usage = callUsage(record, pricing);
	assert.equal(usage.estimated, true);
	assert.equal(usage.usd, 2 + 0.1 + 2);
	assert.equal(priceFor("Claude Opus 5.5", pricing), pricing.models["claude-opus-5-5"]);
	assert.equal(priceFor("gpt-6-luna", pricing), null);
});

test("a root agent that runs again is the next turn; parallel subagents of one name are numbered", () => {
	const tasks = [tool("r1", "conductor", "task", 1), tool("r1", "conductor", "task", 1), tool("r1", "conductor", "task", 1)];
	const scouts = tasks.map((task, index) =>
		span("invoke_agent scout", task.spanId, 1 + index * 0.01, 4, { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "scout" }, `scout${index}`),
	);
	const view = sessionOf([
		...tasks,
		...scouts,
		span("invoke_agent conductor", null, 0, 5, { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "conductor" }, "r1"),
		chat("r1", 0, 1, { "github.copilot.initiator": "user" }),
		span("invoke_agent conductor", "elsewhere", 6, 8, { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "conductor" }, "r2"),
		chat("r2", 6, 7, { "github.copilot.initiator": "agent" }),
	]);
	assert.deepEqual(view.rootAgents.map((agent) => agent.turn), [1, 2]);
	assert.deepEqual(view.subagents.map((agent) => agent.label), ["scout #1", "scout #2", "scout #3"]);
});

test("a SubagentStart hook shows the subagent before its first span", () => {
	const store = storeWith([chat("root", 0, 2, { "github.copilot.initiator": "user" })]);
	ingest(store, {
		kind: "hook",
		time: T0 + 2500,
		data: { hook_event_name: "SubagentStart", session_id: CONVERSATION, agent_id: "call_x", agent_type: "scout" },
	});
	const view = deriveSession(store.sessions.get(CONVERSATION), { now: T0 + 3000 });
	const scout = view.subagents.find((agent) => agent.name === "scout");
	assert.equal(scout.status, "running");
	assert.equal(scout.parentKey, "root");
});

test("todo lists are read from VS Code's shape and from a todos array", () => {
	assert.deepEqual(extractTodos({ todoList: [{ id: 1, title: "Intake", status: "completed" }] }), [
		{ title: "Intake", status: "completed" },
	]);
	assert.deepEqual(extractTodos({ todos: [{ content: "Build", status: "in_progress" }] }), [
		{ title: "Build", status: "in_progress" },
	]);
	assert.equal(extractTodos({ filePath: "a.ts" }), null);
});

test("a tool call's summary names what it touched", () => {
	assert.equal(summarizeArguments({ agent_type: "scout", description: "the ticket" }), "scout · the ticket");
	assert.equal(summarizeArguments({ filePath: "src/a.ts" }), "src/a.ts");
	assert.equal(summarizeArguments(null), "");
});
