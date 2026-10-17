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
	return { sessions: new Map(), lastEventAt: 0, spansSeen: 0, hooksSeen: 0, lastLagMs: null };
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

export function ingest(store, envelope) {
	const time = envelope.time ?? Date.now();
	store.lastEventAt = Math.max(store.lastEventAt, time);
	if (envelope.kind === "span") {
		const span = envelope.data;
		if (!span?.spanId || span.name?.startsWith("session.")) return;
		const id = span.attributes?.["gen_ai.conversation.id"] ?? span.traceId;
		sessionFor(store, id, span.end ?? span.start ?? time).spans.set(span.spanId, span);
		store.spansSeen += 1;
		if (span.receivedAt && span.end) store.lastLagMs = span.receivedAt - span.end;
	} else if (envelope.kind === "hook") {
		const event = envelope.data ?? {};
		const id = event.session_id ?? event.sessionId ?? "hooks";
		sessionFor(store, id, time).hooks.push({ ...event, time });
		store.hooksSeen += 1;
	}
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
	return parts.join(" · ").slice(0, 160);
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
		launchCallId: null,
		brief: null,
		models: new Set(),
		totals: emptyTotals(),
		ownTotals: null,
		toolCount: 0,
		lastTool: null,
		calls: [],
		tools: [],
		children: [],
		...fields,
	};
}

export function deriveSession(session, { now = Date.now(), pricing = null } = {}) {
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
				name: a["gen_ai.agent.name"] ?? span.name.replace(/^invoke_agent\s*/, ""),
				description: a["gen_ai.agent.description"] ?? null,
				type: a["github.copilot.agent.type"] ?? null,
				start: span.start,
				end: span.end,
				lastActivity: span.end,
				done: true,
				status: span.status?.code === 2 ? "failed" : "done",
				parentSpanId: span.parentSpanId,
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
				failed: span.status?.code === 2 || Boolean(a["error.type"]),
				start: span.start,
				end: span.end,
				agentKey: agent.key,
				permission: null,
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
	// A root agent that runs again is the next turn of the conversation, not another instance.
	let turn = 0;
	for (const agent of [...all].filter((a) => a.root).sort((x, y) => x.start - y.start)) {
		turn += 1;
		agent.turn = turn;
		agent.label = agent.name;
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
			durationMs: (hook.end ?? now) - hook.start,
			instance: 1,
		});
		agents.set(agent.key, agent);
		all.push(agent);
		if (root) root.children.push(agent.key);
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

	const lastActivityAt = Math.max(session.lastAt, ...all.map((agent) => agent.lastActivity));
	return {
		id: session.id,
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
		turns: rootAgents.length,
		todos,
		log,
	};
}

/** The sessions, most recent first, each with what the session list shows. */
export function listSessions(store, options) {
	return [...store.sessions.values()]
		.map((session) => deriveSession(session, options))
		.sort((x, y) => y.lastActivityAt - x.lastActivityAt);
}
