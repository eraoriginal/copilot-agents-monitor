import assert from "node:assert/strict";
import { test } from "node:test";
import {
	callUsage,
	createStore,
	deriveSession,
	extractTodos,
	handoffOf,
	ingest,
	mcpLabel,
	mcpOf,
	messageText,
	priceFor,
	weightedTokens,
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

const invoke = (name, parent, startS, endS, id) =>
	span(`invoke_agent ${name}`, parent, startS, endS, { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": name }, id);

/**
 * What the agent host exports when subagents run in the background: the lead's first run launches
 * two, ends as the last finishes (t=5), and a second run starts at once to read them.
 */
function backgroundRuns({ secondRun = [], gapS = 0.02 } = {}) {
	const tasks = [tool("r1", "lead", "task", 1), tool("r1", "lead", "task", 1)];
	return [
		invoke("lead", null, 0, 5, "r1"),
		chat("r1", 0, 1, { "github.copilot.initiator": "user" }),
		...tasks,
		invoke("finder", tasks[0].spanId, 1, 3, "finder"),
		invoke("checker", tasks[1].spanId, 1, 4.9, "checker"),
		invoke("lead", null, 5 + gapS, 9, "r2"),
		chat("r2", 5 + gapS, 6, { "github.copilot.initiator": "agent" }),
		...secondRun,
	];
}

test("a run the host starts to read the subagents' answers continues the turn, and gets their returns", () => {
	const view = sessionOf(
		backgroundRuns({ secondRun: [tool("r2", "lead", "read_agent", 5.02), tool("r2", "lead", "read_agent", 5.03)] }),
	);
	const [first, second] = view.rootAgents;
	assert.equal(second.resumeOf, first.key);
	assert.deepEqual(view.rootAgents.map((agent) => agent.turn), [1, 1]);
	assert.equal(view.turns, 1);
	// They stay launched by the first run; their answers go to the one that read them.
	for (const key of ["finder", "checker"]) {
		assert.equal(view.agents.get(key).parentKey, "r1");
		assert.equal(view.agents.get(key).returnKey, "r2");
	}
});

test("a run that follows at once without reading is a new turn, and answers go back to the launcher", () => {
	const view = sessionOf(backgroundRuns());
	assert.equal(view.rootAgents[1].resumeOf, null);
	assert.deepEqual(view.rootAgents.map((agent) => agent.turn), [1, 2]);
	assert.equal(view.turns, 2);
	assert.equal(view.agents.get("finder").returnKey, "r1");
});

test("a run that reads after a pause is a new turn: the host starts the next run at once", () => {
	const view = sessionOf(backgroundRuns({ gapS: 30, secondRun: [tool("r2", "lead", "read_agent", 36)] }));
	assert.equal(view.rootAgents[1].resumeOf, null);
	assert.equal(view.turns, 2);
	assert.equal(view.agents.get("checker").returnKey, "r1");
});

test("an answer read inside the launching run goes back to it, the other to the run that reads it", () => {
	// The first run waits on finder (ends t=3) with a read that ends as it does; checker is read later.
	const waiting = span(
		"execute_tool read_agent",
		"r1",
		2.5,
		3,
		{ "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "read_agent", "gen_ai.tool.call.id": "wait", "gen_ai.agent.name": "lead" },
	);
	const view = sessionOf(backgroundRuns({ secondRun: [waiting, tool("r2", "lead", "read_agent", 5.02)] }));
	assert.equal(view.rootAgents[1].resumeOf, "r1");
	assert.equal(view.agents.get("finder").returnKey, "r1");
	assert.equal(view.agents.get("checker").returnKey, "r2");
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

test("a tool call keeps what its span reports, the agent it launched, and the result a hook adds", () => {
	const task = tool("root", "lead", "task", 3);
	const shell = span("execute_tool powershell powershell.exe", "sub", 4, 5, {
		"gen_ai.operation.name": "execute_tool",
		"gen_ai.tool.name": "powershell",
		"gen_ai.tool.call.id": "call_shell",
		"gen_ai.agent.name": "finder",
		"process.executable.name": "powershell.exe",
		"process.exit.code": 1,
	});
	shell.events = [
		{ name: "github.copilot.sandbox.enforcement_state", attributes: { "github.copilot.sandbox.outcome": "inactive" } },
	];
	const store = storeWith([
		chat("root", 0, 2, { "github.copilot.initiator": "user" }),
		task,
		shell,
		span("invoke_agent finder", task.spanId, 3, 6, { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "finder" }, "sub"),
	]);
	ingest(store, {
		kind: "hook",
		time: T0 + 5000,
		data: {
			hook_event_name: "PostToolUse",
			session_id: CONVERSATION,
			tool_use_id: "call_shell",
			tool_input: { command: "npm test" },
			tool_response: "1 failing",
		},
	});
	const view = deriveSession(store.sessions.get(CONVERSATION), { now: T0 + 20_000 });
	const launch = view.agents.get("root").tools.find((call) => call.name === "task");
	assert.equal(launch.launchedKey, "sub");
	const call = view.agents.get("sub").tools[0];
	assert.deepEqual(call.facts, [
		["process", "powershell.exe"],
		["exit code", "1"],
		["sandbox", "inactive"],
	]);
	assert.deepEqual(call.args, { command: "npm test" });
	assert.equal(call.summary, "npm test");
	assert.equal(call.result, "1 failing");
});

test("a tool call's result is read from content capture", () => {
	const view = sessionOf([
		chat("root", 0, 2, { "github.copilot.initiator": "user" }),
		tool("root", "lead", "read_file", 2.5, {
			"gen_ai.tool.call.arguments": '{"filePath":"a.ts"}',
			"gen_ai.tool.call.result": '{"lines":12}',
		}),
	]);
	const call = view.agents.get("root").tools[0];
	assert.deepEqual(call.args, { filePath: "a.ts" });
	assert.deepEqual(call.result, { lines: 12 });
	assert.deepEqual(call.facts, []);
});

test("a subagent's handoff: the prompt its task call sent, and the answer that came back", () => {
	const task = tool("root", "lead", "task", 3, {
		"gen_ai.tool.call.arguments": JSON.stringify({ agent_type: "finder", description: "the cart", prompt: "Read sample/cart.js.\nReport the bugs." }),
		"gen_ai.tool.call.result": JSON.stringify([{ type: "text", text: "Two bugs: an off-by-one, a missing await." }]),
	});
	const view = sessionOf([
		chat("root", 0, 2, { "github.copilot.initiator": "user" }),
		task,
		chat("sub", 3.5, 5, { "github.copilot.initiator": "sub-agent" }),
		span("invoke_agent finder", task.spanId, 3, 6, { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": "finder" }, "sub"),
	]);
	const { sent, returned } = handoffOf(view.agents.get("sub"));
	assert.equal(sent.title, "the cart");
	assert.equal(sent.text, "Read sample/cart.js.\nReport the bugs.");
	assert.deepEqual(sent.fields, [["agent_type", "finder"]]);
	assert.equal(sent.at, task.start);
	assert.equal(returned.text, "Two bugs: an off-by-one, a missing await.");
	assert.equal(returned.at, T0 + 6000);
});

test("a handoff falls back on the messages of the subagent's own span, and knows what it lacks", () => {
	const task = tool("root", "lead", "task", 3, { "gen_ai.tool.call.arguments": '{"description":"the cart"}' });
	const view = sessionOf([
		chat("root", 0, 2, { "github.copilot.initiator": "user" }),
		task,
		span("invoke_agent finder", task.spanId, 3, 6, {
			"gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.name": "finder",
			"gen_ai.input.messages": JSON.stringify([
				{ role: "system", parts: [{ type: "text", content: "You are finder." }] },
				{ role: "user", parts: [{ type: "text", content: "Look at the cart." }] },
			]),
			"gen_ai.output.messages": JSON.stringify([
				{ role: "assistant", parts: [{ type: "tool_call", name: "view" }, { type: "text", content: "Found it." }] },
			]),
		}, "sub"),
		tool("pending", "checker", "view", 4.2),
	]);
	const finder = handoffOf(view.agents.get("sub"));
	assert.equal(finder.sent.text, "Look at the cart.");
	assert.equal(finder.returned.text, "Found it.");
	// A subagent with no launch call known and no content: nothing to show, nothing invented.
	const checker = handoffOf(view.agents.get("pending"));
	assert.equal(checker.sent.text, null);
	assert.equal(checker.sent.title, null);
	assert.equal(checker.returned.text, null);
	assert.equal(checker.returned.at, null);
});

test("message text is read from strings, GenAI messages and tool result shapes", () => {
	assert.equal(messageText("done"), "done");
	assert.equal(messageText("   "), null);
	assert.equal(messageText({ textResultForLlm: "ok", resultType: "success" }), "ok");
	assert.equal(messageText({ content: [{ type: "text", text: "a" }, { type: "text", text: "b" }] }), "a\n\nb");
	assert.equal(messageText([{ role: "user", parts: [{ type: "text", content: "hi" }] }, { role: "assistant", parts: [{ type: "text", content: "yo" }] }], "assistant"), "yo");
	assert.equal(messageText({ unknown: true }), null);
});

const GITHUB_HASH = "4c96a3dc55eb446a58524cf5336260ffb09488a0e0ce48bff0368c261d2f7f6e"; // sha256("github-mcp-server")
const ATLASSIAN_HASH = "a".repeat(64);

const mcpTool = (parent, agentName, hash, mcpTool, startS, extra = {}) =>
	tool(parent, agentName, `server-${mcpTool}`, startS, {
		"gen_ai.tool.type": "extension",
		"github.copilot.tool.parameters.mcp_server_name_hash": hash,
		"github.copilot.tool.parameters.mcp_tool_name": mcpTool,
		...extra,
	});

test("Copilot's default agent, a bare invoke_agent span, is named agent, not left blank", () => {
	const view = sessionOf([
		chat("root", 0, 1, { "github.copilot.initiator": "user" }),
		span("invoke_agent", null, 0, 2, { "gen_ai.operation.name": "invoke_agent" }, "root"),
	]);
	assert.equal(view.agents.get("root").label, "agent");
	assert.equal(view.title, "agent");
});

test("an MCP call is told from a built-in one, its server named from its hash, its clear name, or VS Code's naming", () => {
	const names = { [GITHUB_HASH]: "github-mcp-server" };
	assert.deepEqual(mcpOf(mcpTool("a", "lead", GITHUB_HASH, "search_issues", 1), names), { server: "github-mcp-server", hash: GITHUB_HASH, tool: "search_issues" });
	// An unknown hash keeps the call an MCP call, named by the start of its hash.
	const unknown = mcpOf(mcpTool("a", "lead", ATLASSIAN_HASH, "getJiraIssue", 1), names);
	assert.equal(unknown.server, null);
	assert.equal(mcpLabel(unknown), "server aaaaaaa");
	// With content capture, the name comes in clear.
	assert.equal(mcpOf(mcpTool("a", "lead", ATLASSIAN_HASH, "getJiraIssue", 1, { "github.copilot.tool.parameters.mcp_server_name": "atlassian" }), names).server, "atlassian");
	// VS Code's chat extension names an MCP tool mcp_<server>_<tool>.
	assert.deepEqual(mcpOf(tool("a", "lead", "mcp_atlassian_getJiraIssue", 1), names), { server: "atlassian", hash: null, tool: "getJiraIssue" });
	assert.equal(mcpOf(tool("a", "lead", "read_file", 1), names), null);
});

test("each agent's MCP use is summed by server, beside the servers its span says it could call", () => {
	const store = storeWith([
		chat("root", 0, 1, { "github.copilot.initiator": "user" }),
		mcpTool("root", "lead", GITHUB_HASH, "search_issues", 1.2),
		mcpTool("root", "lead", GITHUB_HASH, "get_issue", 1.4),
		mcpTool("root", "lead", ATLASSIAN_HASH, "getJiraIssue", 1.6, { "error.type": "Timeout" }),
		tool("root", "lead", "read_file", 1.8),
		chat("root", 2, 3, { "github.copilot.initiator": "agent" }),
		span("invoke_agent lead", null, 0, 4, {
			"gen_ai.operation.name": "invoke_agent",
			"gen_ai.agent.name": "lead",
			"github.copilot.context.mcp_server_names": JSON.stringify([GITHUB_HASH, ATLASSIAN_HASH, "b".repeat(64)]),
		}, "root"),
	]);
	const view = deriveSession(store.sessions.get(CONVERSATION), { now: T0 + 20_000, mcpNames: { [GITHUB_HASH]: "github-mcp-server" } });
	const lead = view.agents.get("root");
	assert.deepEqual(
		lead.mcp.map((entry) => [mcpLabel(entry), entry.calls, entry.failed, [...entry.tools]]),
		[
			["github-mcp-server", 2, 0, [["search_issues", 1], ["get_issue", 1]]],
			["server aaaaaaa", 1, 1, [["getJiraIssue", 1]]],
		],
	);
	assert.deepEqual(lead.mcpAvailable.map(mcpLabel), ["github-mcp-server", "server aaaaaaa", "server bbbbbbb"]);
	assert.deepEqual(view.mcp.map((entry) => entry.calls), [2, 1]);
	assert.equal(view.mcpAvailable.length, 3);
	assert.equal(lead.tools.find((call) => call.name === "read_file").mcp, null);
});

test("a tool result's tokens are the growth of the next call's input, shared by the calls of its round", () => {
	const usage = (input, output) => ({ "gen_ai.usage.input_tokens": input, "gen_ai.usage.output_tokens": output, "gen_ai.usage.cache_read.input_tokens": 0 });
	const view = sessionOf([
		chat("root", 0, 1, { "github.copilot.initiator": "user", ...usage(1000, 100) }),
		mcpTool("root", "lead", GITHUB_HASH, "search_issues", 1.1),
		tool("root", "lead", "read_file", 1.2),
		chat("root", 2, 3, { "github.copilot.initiator": "agent", ...usage(3100, 200) }),
		mcpTool("root", "lead", GITHUB_HASH, "get_issue", 3.1),
		chat("root", 4, 5, { "github.copilot.initiator": "agent", ...usage(4300, 50) }),
		chat("root", 6, 7, { "github.copilot.initiator": "agent", ...usage(4400, 50) }),
		mcpTool("root", "lead", GITHUB_HASH, "list_issues", 7.1),
	]);
	const [search, read, get, list] = view.agents.get("root").tools.sort((x, y) => x.start - y.start);
	// 3100 − 1000 − 100 = 2000 tokens came back from the first round, shared by its two calls.
	assert.equal(search.cost.tokens, 1000);
	assert.equal(read.cost.tokens, 1000);
	assert.equal(search.cost.shared, true);
	assert.equal(search.cost.reads, 3);
	// 4300 − 3100 − 200 = 1000, read by the last two calls.
	assert.equal(get.cost.tokens, 1000);
	assert.equal(get.cost.reads, 2);
	assert.equal(get.cost.shared, false);
	// Priced at the rate each reading call was billed: fresh for the first, from the cache after.
	const [, second, third, fourth] = view.agents.get("root").calls.sort((x, y) => x.start - y.start);
	const rate = (call) => call.usage.credits / weightedTokens(call.usage);
	assert.ok(Math.abs(get.cost.credits - (1000 * rate(third) + 1000 * 0.1 * rate(fourth))) < 1e-12);
	assert.ok(search.cost.credits > 1000 * rate(second));
	// No call has read the last result yet.
	assert.equal(list.cost, null);
});

test("results known for every call of a round share its tokens by their size", () => {
	const usage = (input, output) => ({ "gen_ai.usage.input_tokens": input, "gen_ai.usage.output_tokens": output });
	const view = sessionOf([
		chat("root", 0, 1, { "github.copilot.initiator": "user", ...usage(1000, 0) }),
		mcpTool("root", "lead", GITHUB_HASH, "search_issues", 1.1, { "gen_ai.tool.call.result": "x".repeat(300) }),
		tool("root", "lead", "read_file", 1.2, { "gen_ai.tool.call.result": "y".repeat(100) }),
		chat("root", 2, 3, { "github.copilot.initiator": "agent", ...usage(1800, 0) }),
	]);
	const [search, read] = view.agents.get("root").tools.sort((x, y) => x.start - y.start);
	assert.equal(search.cost.tokens, 600);
	assert.equal(read.cost.tokens, 200);
	assert.equal(search.cost.shared, false);
});
