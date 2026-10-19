/**
 * The state model, shared by the page and the tests: no DOM, no Node.
 *
 * `ingest` only indexes what arrives; `deriveSession` rebuilds the view of one session from its
 * spans and hook events each time the page renders. Spans arrive children first (a span is
 * exported when it ends), so deriving from the whole set is what keeps out-of-order arrival
 * simple: an agent whose own span has not arrived yet is known from its children, and shows as
 * running until it does.
 *
 * Span shapes are those of Copilot's agent host (service `github-copilot`):
 *   invoke_agent <name>   one agent run; a subagent's is a child of the `execute_tool task` that started it
 *   chat <model>          one LLM call, child of its agent: tokens, `github.copilot.nano_aiu`
 *   execute_tool <tool>   one tool call, child of its agent: `gen_ai.tool.call.id`, `gen_ai.agent.name`
 *   permission            child of a tool call: `github.copilot.permission.result`
 */

const NANO_PER_CREDIT = 1e9;
const STALLED_AFTER_MS = 120_000;
const SUBAGENT_TOOLS = new Set(["task", "runSubagent", "agent", "run_subagent"]);

export function createStore() {
	// `traces`: the session each trace belongs to, by trace ID.
	return { sessions: new Map(), traces: new Map(), lastEventAt: 0, spansSeen: 0, hooksSeen: 0, lastLagMs: null };
}

/** The trace ID of a W3C `traceparent`, `00-<trace>-<span>-<flags>`, or null. */
function traceOf(traceparent) {
	const parts = typeof traceparent === "string" ? traceparent.split("-") : [];
	return parts.length >= 3 && parts[1] ? parts[1] : null;
}

function sessionFor(store, id, time) {
	let session = store.sessions.get(id);
	if (!session) {
		session = { id, spans: new Map(), hooks: [], firstAt: time, lastAt: time };
		store.sessions.set(id, session);
	}
	if (Number.isFinite(time)) {
		session.firstAt = Math.min(session.firstAt, time);
		session.lastAt = Math.max(session.lastAt, time);
	}
	// Bumped on every event, so a page can keep the derived view of a quiet session.
	session.version = (session.version ?? 0) + 1;
	return session;
}

/**
 * Indexes one event under its session, and returns that session's ID (undefined when ignored).
 *
 * VS Code gives each subagent hook events of its own `session_id`, while its spans carry the
 * conversation ID of the session that launched it. Every event carries the trace of the turn,
 * though: a hook goes to the session that trace belongs to, so a subagent never shows as a
 * session of its own.
 */
export function ingest(store, envelope) {
	const time = envelope.time ?? Date.now();
	store.lastEventAt = Math.max(store.lastEventAt, time);
	if (envelope.kind === "span") {
		const span = envelope.data;
		if (!span?.spanId || span.name?.startsWith("session.")) return undefined;
		const conversation = span.attributes?.["gen_ai.conversation.id"];
		if (conversation && span.traceId && !store.traces.has(span.traceId)) store.traces.set(span.traceId, conversation);
		const id = conversation ?? store.traces.get(span.traceId) ?? span.traceId;
		sessionFor(store, id, span.end ?? span.start ?? time).spans.set(span.spanId, span);
		store.spansSeen += 1;
		if (span.receivedAt && span.end) store.lastLagMs = span.receivedAt - span.end;
		return id;
	}
	if (envelope.kind === "hook") {
		const event = envelope.data ?? {};
		let id = event.session_id ?? event.sessionId ?? "hooks";
		const trace = traceOf(event.traceparent);
		const owner = trace ? store.traces.get(trace) : null;
		// A session with spans of its own is a conversation: its hooks stay with it.
		if (owner && owner !== id && !store.sessions.get(id)?.spans.size) id = owner;
		else if (trace && !owner) store.traces.set(trace, id);
		sessionFor(store, id, time).hooks.push({ ...event, time });
		store.hooksSeen += 1;
		return id;
	}
	return undefined;
}

// ---------------------------------------------------------------------------------------------
// Costs and tokens.

export function priceFor(model, pricing) {
	if (!model || !pricing?.models) return null;
	const key = model.toLowerCase().replace(/[.\s_]/g, "-");
	let best = null;
	for (const candidate of Object.keys(pricing.models)) {
		if (key.includes(candidate) && (!best || candidate.length > best.length)) best = candidate;
	}
	return best ? pricing.models[best] : null;
}

/** Tokens and cost of one LLM call. Copilot reports what it bills in nano AI credits. */
export function callUsage(span, pricing) {
	const a = span.attributes ?? {};
	const usage = {
		input: a["gen_ai.usage.input_tokens"] ?? 0,
		output: a["gen_ai.usage.output_tokens"] ?? 0,
		cacheRead: a["gen_ai.usage.cache_read.input_tokens"] ?? 0,
		cacheWrite:
			a["gen_ai.usage.cache_write.input_tokens"] ?? a["gen_ai.usage.cache_creation.input_tokens"] ?? 0,
		reasoning: a["gen_ai.usage.reasoning.output_tokens"] ?? a["gen_ai.usage.reasoning_tokens"] ?? 0,
		credits: null,
		usd: null,
		estimated: false,
	};
	const nano = a["github.copilot.nano_aiu"];
	if (typeof nano === "number") {
		usage.credits = nano / NANO_PER_CREDIT;
		usage.usd = usage.credits * (pricing?.usdPerCredit ?? 0.01);
		return usage;
	}
	const price = priceFor(a["gen_ai.response.model"] ?? a["gen_ai.request.model"], pricing);
	if (price) {
		// Input counts include the cached part; each part is priced at its own rate.
		const uncached = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
		usage.usd =
			(uncached * price.input +
				usage.cacheRead * (price.cacheRead ?? price.input) +
				usage.cacheWrite * (price.cacheWrite ?? price.input) +
				usage.output * price.output) /
			1e6;
		usage.credits = usage.usd / (pricing?.usdPerCredit ?? 0.01);
		usage.estimated = true;
	}
	return usage;
}

function emptyTotals() {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		reasoning: 0,
		credits: 0,
		usd: 0,
		priced: 0,
		unpriced: 0,
		estimated: 0,
		calls: 0,
	};
}

function addUsage(totals, usage) {
	totals.input += usage.input;
	totals.output += usage.output;
	totals.cacheRead += usage.cacheRead;
	totals.cacheWrite += usage.cacheWrite;
	totals.reasoning += usage.reasoning;
	totals.calls += 1;
	if (usage.credits == null) {
		totals.unpriced += 1;
	} else {
		totals.credits += usage.credits;
		totals.usd += usage.usd;
		totals.priced += 1;
		if (usage.estimated) totals.estimated += 1;
	}
}

/** What a token weighs in a call's price, relative to an uncached input token: list prices' ratios. */
export const TOKEN_WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 };

/** A call's tokens, each counted at its weight: what the call's price is spread over. */
export function weightedTokens(usage) {
	const uncached = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
	return (
		uncached * TOKEN_WEIGHTS.input +
		usage.cacheRead * TOKEN_WEIGHTS.cacheRead +
		usage.cacheWrite * TOKEN_WEIGHTS.cacheWrite +
		usage.output * TOKEN_WEIGHTS.output
	);
}

/**
 * What tool results cost in tokens. Tool spans carry no token count, but a result enters the
 * agent's context with its next LLM call and is sent again with every call after. Its tokens are
 * the growth of that next call's input over the previous call's input and output, shared among
 * the tool calls of that round: by the size of their results when each is known, evenly
 * otherwise. The first call reads them as fresh input, later ones from the cache; each read is
 * priced at the rate its call was billed, per weighted token. Sets `tool.cost`, an estimate:
 * `{ tokens, reads, credits, shared }`, or leaves it null when no later call has read the result.
 */
export function estimateToolCosts(agent) {
	const calls = [...agent.calls].sort((x, y) => x.start - y.start);
	const sizeOf = (value) => (typeof value === "string" ? value : JSON.stringify(value) ?? "").length;
	for (let index = 0; index + 1 < calls.length; index += 1) {
		const before = calls[index];
		const after = calls[index + 1];
		const round = agent.tools.filter(
			(tool) => tool.start >= (before.end ?? before.start) - 50 && (tool.end ?? tool.start) <= after.start + 50,
		);
		if (round.length === 0) continue;
		const growth = Math.max(0, after.usage.input - before.usage.input - before.usage.output);
		const sizes = round.map((tool) => (tool.result == null ? null : sizeOf(tool.result)));
		const bySize = sizes.every((size) => size != null) && sizes.some((size) => size > 0);
		const total = bySize ? sizes.reduce((sum, size) => sum + size, 0) : round.length;
		const readers = calls.slice(index + 1);
		for (const [position, tool] of round.entries()) {
			const tokens = Math.round((growth * (bySize ? sizes[position] : 1)) / total);
			let credits = 0;
			let priced = true;
			for (const [order, call] of readers.entries()) {
				if (call.usage.credits == null) {
					priced = false;
					continue;
				}
				const rate = call.usage.credits / Math.max(1, weightedTokens(call.usage));
				credits += tokens * (order === 0 ? TOKEN_WEIGHTS.input : TOKEN_WEIGHTS.cacheRead) * rate;
			}
			tool.cost = { tokens, reads: readers.length, credits: priced ? credits : null, shared: round.length > 1 && !bySize };
		}
	}
}

// ---------------------------------------------------------------------------------------------
// MCP servers. Copilot reports a server's name as its SHA-256, in clear only with content
// capture; `names` maps the hashes the monitor could work out back to names.

const SHA256 = /^[0-9a-f]{64}$/;

/** A server's name from what a span carries: the name itself, or a hash `names` knows. */
export function mcpServerName(value, names) {
	if (typeof value !== "string" || value === "") return null;
	return SHA256.test(value) ? (names?.[value] ?? null) : value;
}

/**
 * The MCP server and tool behind a tool call, or null for a built-in tool: from Copilot's
 * `github.copilot.tool.parameters.mcp_*` attributes, `gen_ai.tool.type` "extension", or VS Code's
 * `mcp_<server>_<tool>` names.
 */
export function mcpOf(span, names) {
	const a = span.attributes ?? {};
	const raw = a["github.copilot.tool.parameters.mcp_server_name"];
	const hash = a["github.copilot.tool.parameters.mcp_server_name_hash"];
	const tool = a["github.copilot.tool.parameters.mcp_tool_name"];
	const name = a["gen_ai.tool.name"] ?? span.name.replace(/^execute_tool\s*/, "");
	const named = /^mcp_{1,2}([^_]+?)_{1,2}(.+)$/.exec(name);
	if (!raw && !hash && !tool && a["gen_ai.tool.type"] !== "extension" && !named) return null;
	return {
		server: mcpServerName(raw, names) ?? mcpServerName(hash, names) ?? named?.[1] ?? null,
		hash: typeof hash === "string" && SHA256.test(hash) ? hash : null,
		tool: tool ?? named?.[2] ?? name,
	};
}

/** What to call a server: its name, or the start of its hash when no name is known. */
export function mcpLabel({ server, hash }) {
	return server ?? (hash ? `server ${hash.slice(0, 7)}` : "unknown server");
}

/** MCP use by server: calls, failures, the tools called, the agents, what the results cost. */
function mcpByServer(tools) {
	const servers = new Map();
	for (const tool of tools) {
		if (!tool.mcp) continue;
		const key = tool.mcp.server ?? tool.mcp.hash ?? "?";
		const entry = servers.get(key) ?? {
			key,
			server: tool.mcp.server,
			hash: tool.mcp.hash,
			calls: 0,
			failed: 0,
			tools: new Map(),
			agents: new Set(),
			tokens: 0,
			credits: 0,
			costed: 0,
		};
		entry.calls += 1;
		if (tool.failed) entry.failed += 1;
		entry.tools.set(tool.mcp.tool, (entry.tools.get(tool.mcp.tool) ?? 0) + 1);
		entry.agents.add(tool.agentKey);
		if (tool.cost) {
			entry.tokens += tool.cost.tokens;
			entry.credits += tool.cost.credits ?? 0;
			entry.costed += 1;
		}
		servers.set(key, entry);
	}
	return [...servers.values()].sort((x, y) => y.calls - x.calls || x.key.localeCompare(y.key));
}

// ---------------------------------------------------------------------------------------------
// Tool arguments, when content capture or hooks provide them.

function parseArguments(value) {
	if (value == null) return null;
	if (typeof value !== "string") return value;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/** One line that says what a tool call did: the file, the command, the agent it started. */
export function summarizeArguments(args) {
	if (args == null) return "";
	if (typeof args === "string") return args.slice(0, 160);
	const keys = [
		"agent_type",
		"agentName",
		"subagent_type",
		"description",
		"path",
		"filePath",
		"file_path",
		"command",
		"query",
		"pattern",
	];
	const parts = [];
	for (const key of keys) {
		if (typeof args[key] === "string" && args[key].length > 0) parts.push(args[key]);
		if (parts.length === 2) break;
	}
	// Arguments of no known shape, as MCP tools take (`issueIdOrKey`, `pageId`…): the first ones.
	if (parts.length === 0) {
		for (const value of Object.values(args)) {
			if ((typeof value === "string" && value.length > 0) || typeof value === "number") parts.push(String(value));
			if (parts.length === 2) break;
		}
	}
	return parts.join(" · ").slice(0, 160);
}

/** What a tool span says about the call besides its name, even with content capture off. */
export function toolFacts(span) {
	const a = span.attributes ?? {};
	const facts = [];
	const add = (label, value) => {
		if (value != null && value !== "") facts.push([label, String(value)]);
	};
	add("skill", a["gen_ai.skill.name"]);
	add("resource", a["gen_ai.skill.resource.name"]);
	add("process", a["process.executable.name"]);
	add("exit code", a["process.exit.code"]);
	add("error", a["error.type"] ?? (span.status?.code === 2 ? span.status.message || "failed" : null));
	const sandbox = span.events?.find((event) => event.name === "github.copilot.sandbox.enforcement_state");
	add("sandbox", sandbox?.attributes?.["github.copilot.sandbox.outcome"]);
	return facts;
}

/**
 * The text of a message, whatever carries it: a string, OpenTelemetry GenAI messages
 * (`[{ role, parts: [{ type: "text", content }] }]`), or a tool result (`{ content: [{ text }] }`,
 * `{ textResultForLlm }`…). With `role`, only that role's messages count. Null when no text.
 */
export function messageText(value, role = null) {
	if (value == null) return null;
	if (typeof value === "string") return value.trim() ? value : null;
	if (typeof value !== "object") return String(value);
	if (Array.isArray(value)) {
		const messages = role && value.some((item) => item?.role) ? value.filter((item) => item?.role === role) : value;
		const texts = messages.map((item) => messageText(item)).filter(Boolean);
		return texts.length > 0 ? texts.join("\n\n") : null;
	}
	if (Array.isArray(value.parts)) {
		return messageText(value.parts.filter((part) => part?.type == null || part.type === "text").map((part) => part.content ?? part.text));
	}
	for (const key of ["content", "text", "textResultForLlm", "result", "output", "response"]) {
		const text = messageText(value[key]);
		if (text) return text;
	}
	return null;
}

const PROMPT_KEYS = ["prompt", "message", "task", "instructions"];

/**
 * What an agent was sent by the agent that launched it, and what it sent back: from the arguments
 * and the result of the call that launched it, or from the messages on its own span. Either needs
 * hooks or content capture; without them, only the brief's description may be known.
 */
export function handoffOf(agent) {
	const tool = agent.launchTool;
	const args = tool?.args;
	const fields = args && typeof args === "object" && !Array.isArray(args) ? args : {};
	const promptKey = PROMPT_KEYS.find((key) => typeof fields[key] === "string" && fields[key].trim());
	const result = tool?.result;
	return {
		sent: {
			at: tool?.start ?? (Number.isFinite(agent.start) ? agent.start : null),
			title: typeof fields.description === "string" ? fields.description : null,
			text: (promptKey ? fields[promptKey] : null) ?? messageText(agent.input, "user") ?? (typeof args === "string" ? args : null),
			fields: Object.entries(fields)
				.filter(([key, value]) => key !== promptKey && key !== "description" && value != null && typeof value !== "object")
				.map(([key, value]) => [key, String(value)]),
		},
		returned: {
			at: agent.done ? (agent.end ?? tool?.end ?? null) : null,
			text: messageText(result) ?? messageText(agent.output, "assistant") ?? (result != null ? JSON.stringify(result, null, 2) : null),
		},
	};
}

/** A todo list from any tool input that holds one: VS Code's `todoList`, or a `todos` array. */
export function extractTodos(args) {
	if (!args || typeof args !== "object") return null;
	const list = [args.todoList, args.todos, args.items].find(Array.isArray);
	if (!list) return null;
	const todos = list
		.filter((item) => item && typeof item === "object")
		.map((item) => ({
			title: String(item.title ?? item.content ?? item.text ?? item.description ?? ""),
			status: String(item.status ?? (item.done ? "completed" : "not-started")),
		}))
		.filter((todo) => todo.title.length > 0);
	return todos.length > 0 ? todos : null;
}

// ---------------------------------------------------------------------------------------------
// Deriving one session.

const kindOf = (span) => span.attributes?.["gen_ai.operation.name"] ?? span.name.split(" ")[0];

/**
 * How soon after a run ends the agent host starts the next one to read the subagents it
 * launched. They are background tasks: the host holds the turn until they finish, ends it, and
 * starts another run of the same agent, in milliseconds. A user answering takes longer.
 */
const RESUME_GAP_MS = 5_000;
const READ_TOOL = "read_agent";

/**
 * Whether `run` is the host starting the agent again to read what the subagents `previous`
 * launched sent back, rather than a new message: it follows at once and calls `read_agent`.
 */
function resumes(previous, run) {
	if (run.placeholder || previous.placeholder || !previous.done || previous.children.length === 0) return false;
	return run.start - previous.end <= RESUME_GAP_MS && run.tools.some((tool) => tool.name === READ_TOOL);
}

/**
 * Whether `run` read the answer of `subagent`: a `read_agent` call that ended no earlier than the
 * subagent did. Spans do not say which agent a read was for, short of content capture or hooks.
 */
function readsAnswer(run, subagent) {
	return run.tools.some((tool) => tool.name === READ_TOOL && (tool.end ?? tool.start) >= subagent.end - 100);
}

function newAgent(key, fields) {
	return {
		key,
		name: null,
		label: null,
		description: null,
		type: null,
		start: Number.POSITIVE_INFINITY,
		end: null,
		lastActivity: 0,
		done: false,
		status: "running",
		root: null,
		parentKey: null,
		// Who reads its answer: its launcher, or a later run of the launcher that was started to read it.
		returnKey: null,
		// A root run started by the host to read the subagents the previous run launched: that run's key.
		resumeOf: null,
		launchCallId: null,
		// The `task` call that launched it, and the messages on its own span (content capture).
		launchTool: null,
		input: null,
		output: null,
		brief: null,
		models: new Set(),
		totals: emptyTotals(),
		ownTotals: null,
		toolCount: 0,
		lastTool: null,
		calls: [],
		tools: [],
		children: [],
		// MCP servers it could call, as its own span lists them, and what it called, by server.
		mcpAvailable: [],
		mcp: [],
		...fields,
	};
}

/** The servers an agent's span says it could call: `github.copilot.context.mcp_server_names`. */
function availableServers(value, names) {
	const list = parseArguments(value);
	if (!Array.isArray(list)) return [];
	return list
		.filter((item) => typeof item === "string" && item)
		.map((item) => ({ server: mcpServerName(item, names), hash: SHA256.test(item) ? item : null }));
}

export function deriveSession(session, { now = Date.now(), pricing = null, mcpNames = null } = {}) {
	const spans = [...session.spans.values()];
	const byId = session.spans;
	const agents = new Map();
	const toolsByCallId = new Map();
	const permissionsByTool = new Map();
	const log = [];

	// 1. Agents whose own span has arrived.
	for (const span of spans) {
		if (kindOf(span) !== "invoke_agent") continue;
		const a = span.attributes ?? {};
		agents.set(
			span.spanId,
			newAgent(span.spanId, {
				// Copilot's default agent comes as a bare `invoke_agent`: no name, named further down.
				name: a["gen_ai.agent.name"] || span.name.replace(/^invoke_agent\s*/, "") || null,
				description: a["gen_ai.agent.description"] ?? null,
				type: a["github.copilot.agent.type"] ?? null,
				start: span.start,
				end: span.end,
				lastActivity: span.end,
				done: true,
				status: span.status?.code === 2 ? "failed" : "done",
				parentSpanId: span.parentSpanId,
				input: parseArguments(a["gen_ai.input.messages"]),
				output: parseArguments(a["gen_ai.output.messages"]),
				mcpAvailable: availableServers(a["github.copilot.context.mcp_server_names"], mcpNames),
				ownTotals: {
					input: a["gen_ai.usage.input_tokens"] ?? 0,
					output: a["gen_ai.usage.output_tokens"] ?? 0,
					nano: a["github.copilot.nano_aiu"] ?? null,
				},
			}),
		);
	}

	const ownerOf = (span) => {
		const agent = agents.get(span.parentSpanId);
		if (agent) return agent;
		const key = span.parentSpanId ?? `orphan:${span.traceId}`;
		const provisional = newAgent(key, { parentSpanId: null });
		agents.set(key, provisional);
		return provisional;
	};

	// 2. LLM calls and tool calls, attached to the agent they belong to.
	for (const span of spans) {
		const kind = kindOf(span);
		const a = span.attributes ?? {};
		if (kind === "chat") {
			const agent = ownerOf(span);
			const usage = callUsage(span, pricing);
			const model = a["gen_ai.response.model"] ?? a["gen_ai.request.model"] ?? null;
			if (model) agent.models.add(model);
			const initiator = a["github.copilot.initiator"];
			if (initiator === "sub-agent") agent.root ??= false;
			else if (initiator === "user" || initiator === "agent") agent.root ??= true;
			const call = { kind: "llm", span, model, usage, start: span.start, end: span.end, agentKey: agent.key };
			agent.calls.push(call);
			addUsage(agent.totals, usage);
			agent.start = Math.min(agent.start, span.start);
			agent.lastActivity = Math.max(agent.lastActivity, span.end ?? span.start);
			log.push({ time: span.end ?? span.start, type: "llm", agentKey: agent.key, call });
		} else if (kind === "execute_tool") {
			const agent = ownerOf(span);
			const name = a["gen_ai.tool.name"] ?? span.name.replace(/^execute_tool\s*/, "");
			if (!agent.name && a["gen_ai.agent.name"]) agent.name = a["gen_ai.agent.name"];
			const args = parseArguments(a["gen_ai.tool.call.arguments"]);
			const tool = {
				kind: "tool",
				span,
				name,
				callId: a["gen_ai.tool.call.id"] ?? null,
				args,
				summary: summarizeArguments(args),
				result: parseArguments(a["gen_ai.tool.call.result"]),
				facts: toolFacts(span),
				mcp: mcpOf(span, mcpNames),
				// What its result cost once read by the agent's next LLM calls: see estimateToolCosts.
				cost: null,
				failed: span.status?.code === 2 || Boolean(a["error.type"]),
				start: span.start,
				end: span.end,
				agentKey: agent.key,
				permission: null,
				// The agent a `task` call started, once known.
				launchedKey: null,
			};
			agent.tools.push(tool);
			agent.toolCount += 1;
			agent.start = Math.min(agent.start, span.start);
			agent.lastActivity = Math.max(agent.lastActivity, span.end ?? span.start);
			if (!agent.lastTool || tool.start >= agent.lastTool.start) agent.lastTool = tool;
			if (tool.callId) toolsByCallId.set(tool.callId, tool);
			log.push({ time: span.end ?? span.start, type: "tool", agentKey: agent.key, tool });
		} else if (kind === "permission") {
			permissionsByTool.set(span.parentSpanId, a["github.copilot.permission.result"] ?? null);
		}
	}
	for (const agent of agents.values()) {
		for (const tool of agent.tools) tool.permission = permissionsByTool.get(tool.span.spanId) ?? null;
	}

	// 3. Hook events: start agents before their first span, add the arguments spans leave out.
	const hookAgents = new Map();
	let stopped = null;
	let prompt = null;
	let cwd = null;
	for (const event of session.hooks) {
		const name = event.hook_event_name ?? event.hookEventName;
		cwd ??= event.cwd ?? null;
		if (name === "UserPromptSubmit") prompt ??= event.prompt ?? null;
		if (name === "Stop") stopped = event.time;
		if (name === "SubagentStart" || name === "SubagentStop") {
			const id = event.agent_id ?? event.agentId;
			const entry = hookAgents.get(id) ?? { id, type: event.agent_type ?? event.agentType, start: null, end: null };
			if (name === "SubagentStart") entry.start = event.time;
			else entry.end = event.time;
			hookAgents.set(id, entry);
		}
		if (name === "PreToolUse" || name === "PostToolUse") {
			const callId = event.tool_use_id ?? event.toolUseId;
			const tool = callId ? toolsByCallId.get(callId) : null;
			const args = parseArguments(event.tool_input ?? event.toolArgs);
			if (tool && tool.args == null && args != null) {
				tool.args = args;
				tool.summary = summarizeArguments(args);
			}
			if (tool && name === "PostToolUse") tool.result ??= parseArguments(event.tool_response ?? event.toolResult);
			if (!tool) {
				log.push({
					time: event.time,
					type: "hook-tool",
					agentKey: null,
					hook: { phase: name, tool: event.tool_name ?? event.toolName, summary: summarizeArguments(args), args },
				});
			}
		}
	}

	// What tool results cost, now that hooks have added the results spans leave out; MCP by server.
	for (const agent of agents.values()) {
		estimateToolCosts(agent);
		agent.mcp = mcpByServer(agent.tools);
	}

	// 4. Who started whom. A subagent's span is a child of the `task` call that started it.
	const all = [...agents.values()];
	for (const agent of all) {
		const launcher = agent.parentSpanId ? byId.get(agent.parentSpanId) : null;
		if (launcher && kindOf(launcher) === "execute_tool") {
			const parent = agents.get(launcher.parentSpanId);
			agent.root = false;
			agent.launchCallId = launcher.attributes?.["gen_ai.tool.call.id"] ?? null;
			if (parent) agent.parentKey = parent.key;
			const tool = agent.launchCallId ? toolsByCallId.get(agent.launchCallId) : null;
			if (tool) {
				tool.launchedKey = agent.key;
				agent.launchTool = tool;
			}
			if (tool?.args) agent.brief = summarizeArguments(tool.args);
		}
	}
	const roots = all.filter((agent) => agent.root !== false).sort((x, y) => x.start - y.start);
	for (const agent of all) {
		if (agent.root !== false || agent.parentKey) continue;
		// The `task` span has not arrived yet: the parent is the root agent running at the time.
		const parent = roots
			.filter((root) => root.start <= agent.start && (!root.done || root.end >= agent.start))
			.at(-1);
		if (parent) agent.parentKey = parent.key;
	}
	// Copilot's agent host exports the root agent's spans, its own LLM calls included, when its
	// turn ends; its subagents report live. Until then, their caller stands in as a placeholder.
	const orphans = all.filter((agent) => agent.root === false && !agent.parentKey);
	if (orphans.length > 0) {
		const callerName = spans.find(
			(span) => kindOf(span) === "execute_tool" && span.attributes?.["gen_ai.tool.name"] === "task",
		)?.attributes?.["gen_ai.agent.name"];
		const placeholder = newAgent("pending-root", {
			name: callerName ?? "orchestrator",
			start: Math.min(...orphans.map((agent) => agent.start)),
			lastActivity: Math.max(...orphans.map((agent) => agent.lastActivity)),
			root: true,
			placeholder: true,
			description: "reports its own calls when its turn ends",
		});
		agents.set(placeholder.key, placeholder);
		all.push(placeholder);
		for (const agent of orphans) agent.parentKey = placeholder.key;
	}
	for (const agent of all) {
		if (agent.parentKey) agents.get(agent.parentKey)?.children.push(agent.key);
	}

	// 5. Names, statuses, durations.
	for (const agent of all) {
		// Until its first tool call or its own span, no span carries a subagent's name.
		agent.unnamed = agent.name == null;
		agent.name ??= agent.root === false ? "subagent" : "agent";
		if (agent.root === null) agent.root = !agent.parentKey;
		if (!agent.done) {
			const hook = agent.launchCallId ? hookAgents.get(agent.launchCallId) : null;
			if (hook?.end) {
				agent.done = true;
				agent.end = hook.end;
				agent.status = "done";
			} else {
				agent.status = now - agent.lastActivity > STALLED_AFTER_MS ? "stalled" : "running";
			}
		}
		if (agent.totals.calls === 0 && agent.ownTotals) {
			agent.totals.input = agent.ownTotals.input;
			agent.totals.output = agent.ownTotals.output;
			if (agent.ownTotals.nano != null) {
				agent.totals.credits = agent.ownTotals.nano / NANO_PER_CREDIT;
				agent.totals.usd = agent.totals.credits * (pricing?.usdPerCredit ?? 0.01);
			}
		}
		const end = agent.done ? agent.end : now;
		agent.durationMs = Number.isFinite(agent.start) ? Math.max(0, end - agent.start) : 0;
	}
	// A root agent that runs again is the next turn of the conversation, not another instance;
	// unless the host started it to read the subagents the previous run launched: see `resumeOf`.
	let turn = 0;
	// The runs of the current turn: the first, then those the host started to read subagents.
	let chain = [];
	const runsOf = new Map();
	for (const agent of [...all].filter((a) => a.root).sort((x, y) => x.start - y.start)) {
		const previous = chain.at(-1);
		if (previous && resumes(previous, agent)) {
			agent.resumeOf = previous.key;
			agent.turn = previous.turn;
		} else {
			turn += 1;
			agent.turn = turn;
			chain = [];
		}
		runsOf.set(agent, chain);
		chain.push(agent);
		agent.label = agent.name;
	}
	// Where a subagent's answer goes: to the run that reads it, which may be a later run of the
	// same turn. Without a read, or with the agent still working, it goes back to its launcher.
	for (const agent of all) {
		agent.returnKey = agent.parentKey;
		const launcher = agent.parentKey ? agents.get(agent.parentKey) : null;
		const runs = launcher ? runsOf.get(launcher) : null;
		if (!runs || !agent.done) continue;
		const reader = runs.slice(runs.indexOf(launcher)).find((run) => readsAnswer(run, agent));
		if (reader) agent.returnKey = reader.key;
	}
	const subCounts = new Map();
	for (const agent of all) {
		if (!agent.root) subCounts.set(agent.name, (subCounts.get(agent.name) ?? 0) + 1);
	}
	for (const agent of [...all].filter((a) => !a.root).sort((x, y) => x.start - y.start)) {
		const seen = (subCounts.get(`#${agent.name}`) ?? 0) + 1;
		subCounts.set(`#${agent.name}`, seen);
		agent.instance = seen;
		agent.label = subCounts.get(agent.name) > 1 ? `${agent.name} #${seen}` : agent.name;
	}

	// Subagents a hook announced and no span has shown yet: queued or just started.
	for (const hook of hookAgents.values()) {
		const known = all.some((agent) => agent.launchCallId === hook.id);
		if (known || !hook.start) continue;
		const root = roots.at(-1);
		const agent = newAgent(`hook:${hook.id}`, {
			name: hook.type ?? "subagent",
			label: hook.type ?? "subagent",
			start: hook.start,
			lastActivity: hook.start,
			end: hook.end,
			done: Boolean(hook.end),
			status: hook.end ? "done" : "running",
			root: false,
			parentKey: root?.key ?? null,
			returnKey: root?.key ?? null,
			durationMs: (hook.end ?? now) - hook.start,
			instance: 1,
		});
		agents.set(agent.key, agent);
		all.push(agent);
		if (root) root.children.push(agent.key);
		const launch = toolsByCallId.get(hook.id);
		if (launch) {
			launch.launchedKey ??= agent.key;
			agent.launchTool = launch;
		}
	}

	// 6. Session totals.
	const totals = emptyTotals();
	for (const agent of all) {
		for (const call of agent.calls) addUsage(totals, call.usage);
		if (agent.calls.length === 0 && agent.ownTotals) {
			totals.input += agent.totals.input;
			totals.output += agent.totals.output;
			totals.credits += agent.totals.credits;
			totals.usd += agent.totals.usd;
		}
	}
	const starts = all.map((agent) => agent.start).filter(Number.isFinite);
	const ends = all.map((agent) => (agent.done ? agent.end : now)).filter(Number.isFinite);
	const running = all.filter((agent) => agent.status === "running");
	const rootAgents = all.filter((agent) => agent.root).sort((x, y) => x.start - y.start);
	const subagents = all.filter((agent) => !agent.root).sort((x, y) => x.start - y.start);
	const toolCount = all.reduce((sum, agent) => sum + agent.toolCount, 0);

	let todos = null;
	for (const entry of log) {
		const found = extractTodos(entry.tool?.args ?? entry.hook?.args);
		if (found) todos = found;
	}

	log.sort((x, y) => x.time - y.time);

	const byModel = new Map();
	for (const agent of all) {
		for (const call of agent.calls) {
			const key = call.model ?? "unknown";
			const entry = byModel.get(key) ?? emptyTotals();
			addUsage(entry, call.usage);
			byModel.set(key, entry);
		}
	}

	// MCP across the session: what was called, and what the agents could have called.
	const mcp = mcpByServer(all.flatMap((agent) => agent.tools));
	const mcpAvailable = new Map();
	for (const agent of all) {
		for (const entry of agent.mcpAvailable) {
			const key = entry.server ?? entry.hash;
			const known = mcpAvailable.get(key) ?? { key, ...entry, agents: new Set() };
			known.agents.add(agent.key);
			mcpAvailable.set(key, known);
		}
	}

	const lastActivityAt = Math.max(session.lastAt, ...all.map((agent) => agent.lastActivity));
	// LLM calls and embeddings VS Code makes on its own (titles, intents…): no conversation, no
	// agent, no tool, no hook. Not a session anyone started.
	const background =
		session.hooks.length === 0 &&
		spans.every(
			(span) =>
				!span.attributes?.["gen_ai.conversation.id"] && !["invoke_agent", "execute_tool"].includes(kindOf(span)),
		);
	return {
		id: session.id,
		background,
		title: rootAgents[0]?.name ?? subagents[0]?.name ?? "session",
		prompt,
		cwd,
		startedAt: starts.length ? Math.min(...starts) : session.firstAt,
		endedAt: running.length === 0 && ends.length ? Math.max(...ends) : null,
		lastActivityAt,
		wallMs: starts.length ? Math.max(...ends, Math.min(...starts)) - Math.min(...starts) : 0,
		live: running.length > 0,
		// A Stop hook after the last activity: the agent handed the turn back and waits for an answer.
		waitingForUser: stopped != null && stopped >= lastActivityAt && running.length === 0,
		agents,
		rootAgents,
		subagents,
		running,
		totals,
		byModel,
		toolCount,
		mcp,
		mcpAvailable: [...mcpAvailable.values()],
		turns: rootAgents.filter((agent) => !agent.resumeOf).length,
		todos,
		log,
	};
}

/** The sessions, most recent first, each with what the session list shows: background calls left out. */
export function listSessions(store, options) {
	return [...store.sessions.values()]
		.map((session) => deriveSession(session, options))
		.filter((view) => !view.background)
		.sort((x, y) => y.lastActivityAt - x.lastActivityAt);
}
