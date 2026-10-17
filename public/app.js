import {
	formatClock,
	formatCredits,
	formatDuration,
	formatPercent,
	formatTokens,
	formatUsd,
	shortModel,
} from "./format.js";
import { createStore, deriveSession, ingest } from "./model.js";
import { counterfactual, routingFor } from "./routing.js";
import { definitionsOf, placeOf } from "./workspaces.js";

const store = createStore();
const ui = {
	view: "live",
	pricing: null,
	status: null,
	workspaces: [],
	history: [],
	historyTicket: null,
	place: null,
	routing: [],
	connected: false,
	follow: true,
	sessionId: null,
	agentKey: null,
	renderQueued: false,
	lastRenderAt: 0,
	sessionsSignature: "",
};
const summaries = new Map();
const $ = (id) => document.getElementById(id);

// ---------------------------------------------------------------------------------------------
// DOM helpers. Text only ever goes in through text nodes: tool arguments can hold anything.

function el(tag, props = {}, ...children) {
	const node = document.createElement(tag);
	for (const [key, value] of Object.entries(props)) {
		if (value == null || value === false) continue;
		if (key === "class") node.className = value;
		else if (key === "style") Object.assign(node.style, value);
		else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
		else if (key === "tip") node.dataset.tip = value;
		else node.setAttribute(key, value === true ? "" : String(value));
	}
	for (const child of children.flat()) {
		if (child == null || child === false) continue;
		node.append(child instanceof Node ? child : document.createTextNode(String(child)));
	}
	return node;
}

function replace(id, ...children) {
	$(id).replaceChildren(...children.flat().filter(Boolean));
}

const STATUS_MARK = { running: "●", done: "✓", stalled: "!", failed: "✕" };

function statusChip(status) {
	return el("span", { class: `status ${status}` }, `${STATUS_MARK[status] ?? "·"} ${status}`);
}

// ---------------------------------------------------------------------------------------------
// Sessions.

function summaryOf(session, now) {
	const cached = summaries.get(session.id);
	if (cached && cached.version === session.version && !cached.view.live) return cached.view;
	const view = deriveSession(session, { now, pricing: ui.pricing });
	summaries.set(session.id, { version: session.version, view });
	return view;
}

function sessionLabel(view) {
	const agents = view.agents.size;
	const ticket = placeOf(view, ui.workspaces).ticket;
	const parts = [
		view.live ? "● " : "",
		formatClock(view.startedAt),
		ticket ? ` · ${ticket}` : "",
		` · ${view.title}`,
		` · ${agents} agent${agents === 1 ? "" : "s"}`,
		view.totals.priced ? ` · ${formatCredits(view.totals.credits)}` : "",
	];
	return parts.join("");
}

function renderSessionPicker(views) {
	const signature = views.map((view) => `${view.id}|${sessionLabel(view)}`).join("\n");
	const select = $("session-select");
	if (signature !== ui.sessionsSignature) {
		ui.sessionsSignature = signature;
		select.replaceChildren(
			...views.map((view) => el("option", { value: view.id }, sessionLabel(view))),
		);
	}
	if (ui.sessionId) select.value = ui.sessionId;
}

// ---------------------------------------------------------------------------------------------
// Panels.

function renderLive(view, now) {
	const lag = store.lastLagMs != null ? ` · lag ${formatDuration(Math.max(0, store.lastLagMs))}` : "";
	if (!ui.connected) {
		replace("live", el("span", { class: "dot bad" }), "monitor disconnected — retrying");
		return;
	}
	if (!view) {
		replace("live", el("span", { class: "dot" }), "waiting for the first event");
		return;
	}
	if (view.live) {
		replace("live", el("span", { class: "dot on" }), `LIVE · ${view.running.length} running${lag}`);
	} else if (view.waitingForUser) {
		replace("live", el("span", { class: "dot on" }), "waiting for your answer");
	} else {
		replace(
			"live",
			el("span", { class: "dot" }),
			`idle · last activity ${formatDuration(now - view.lastActivityAt)} ago${lag}`,
		);
	}
}

function kpi(label, value, sub, accent = false) {
	return el(
		"div",
		{ class: "kpi" },
		el("div", { class: "kpi-label" }, label),
		el("div", { class: `kpi-value${accent ? " accent" : ""}`, title: value }, value),
		el("div", { class: "kpi-sub", title: sub }, sub),
	);
}

function renderKpis(view) {
	if (!view) {
		replace("kpis", kpi("cost", "—", "no session yet"));
		return;
	}
	const t = view.totals;
	const costSub = t.unpriced
		? `${formatUsd(t.usd)} · ${t.unpriced} call(s) unpriced`
		: t.estimated
			? `≈ ${formatUsd(t.usd)} · estimated from list prices`
			: `≈ ${formatUsd(t.usd)} · billed by Copilot`;
	const parallel = maxParallel(view.subagents);
	replace(
		"kpis",
		kpi("cost", formatCredits(t.credits), costSub, true),
		kpi("wall clock", formatDuration(view.wallMs), `${view.turns} turn${view.turns === 1 ? "" : "s"}`),
		kpi(
			"agents",
			`${view.running.length} / ${view.agents.size}`,
			`running / total · ${parallel} max in parallel`,
		),
		kpi("tokens", `${formatTokens(t.input)} in`, `${formatTokens(t.output)} out · ${formatTokens(t.reasoning)} reasoning`),
		kpi("cache", formatPercent(t.cacheRead, t.input), `${formatTokens(t.cacheRead)} read · ${formatTokens(t.cacheWrite)} written`),
		kpi("llm calls", String(t.calls), `${view.byModel.size} model${view.byModel.size === 1 ? "" : "s"}`),
		kpi("tool calls", String(view.toolCount), view.prompt ? `“${view.prompt.slice(0, 60)}”` : view.cwd ?? ""),
	);
}

function maxParallel(agents) {
	const edges = [];
	for (const agent of agents) {
		if (!Number.isFinite(agent.start)) continue;
		edges.push([agent.start, 1], [agent.start + agent.durationMs, -1]);
	}
	edges.sort((x, y) => x[0] - y[0] || x[1] - y[1]);
	let current = 0;
	let best = 0;
	for (const [, delta] of edges) {
		current += delta;
		best = Math.max(best, current);
	}
	return best;
}

const ROUTING_LABEL = {
	"as-declared": ["good", "✓", "as declared"],
	fallback: ["warning", "↓", "fallback"],
	"off-list": ["critical", "✕", "off list"],
	undeclared: ["muted", "·", "no model declared"],
	pending: ["muted", "…", "no call yet"],
	unknown: ["muted", "?", "no agent file"],
};

function agentCard(view, agent) {
	const routing = ui.routing.find((row) => row.name === agent.name);
	const flagged = routing && (routing.status === "fallback" || routing.status === "off-list");
	const models = [...agent.models].map((model) =>
		el(
			"span",
			{
				class: `badge${flagged ? " warn" : ""}`,
				title: flagged ? `${ROUTING_LABEL[routing.status][2]} · declared: ${routing.declared.join(", ")}` : model,
			},
			shortModel(model),
		),
	);
	const t = agent.totals;
	const last = agent.lastTool
		? `last ${agent.lastTool.name}${agent.lastTool.summary ? ` · ${agent.lastTool.summary}` : ""}${agent.lastTool.permission ? ` · ${agent.lastTool.permission}` : ""}`
		: null;
	const foot = [`${agent.toolCount} tool${agent.toolCount === 1 ? "" : "s"}`, agent.brief ?? last ?? agent.description]
		.filter(Boolean)
		.join(" · ");
	const selected = ui.agentKey === agent.key;
	return el(
		"button",
		{
			type: "button",
			class: `card ${agent.status}${selected ? " selected" : ""}`,
			"aria-pressed": selected ? "true" : "false",
			onclick: () => {
				ui.agentKey = selected ? null : agent.key;
				scheduleRender(true);
			},
		},
		el(
			"div",
			{ class: "card-top" },
			el(
				"span",
				{ class: "card-name" },
				agent.root ? `${agent.label} · turn ${agent.turn}` : agent.unnamed ? `${agent.label} · identifying…` : agent.label,
			),
			statusChip(agent.status),
		),
		el(
			"div",
			{ class: "card-line" },
			el(
				"span",
				{},
				models.length
					? models
					: el("span", { class: "muted" }, agent.root && !agent.done ? "LLM calls reported at turn end" : "no model yet"),
			),
			el("span", {}, formatDuration(agent.durationMs)),
		),
		el(
			"div",
			{ class: "card-line" },
			el("span", {}, `${formatTokens(t.input)} in · ${formatTokens(t.output)} out`),
			el("span", { class: "card-cost" }, t.priced || t.credits ? formatCredits(t.credits) : "—"),
		),
		el("div", { class: "card-foot", title: foot }, foot),
	);
}

function renderFlow(view, now) {
	if (!view) {
		replace("flow", setupPanel());
		$("flow-meta").textContent = "";
		return;
	}
	const place = ui.place;
	$("flow-meta").textContent = [
		place?.workspaceName,
		place?.branch,
		`${view.subagents.length} subagent${view.subagents.length === 1 ? "" : "s"}`,
		`started ${formatClock(view.startedAt)}`,
	]
		.filter(Boolean)
		.join(" · ");
	const turns = view.rootAgents.map((root) => {
		const children = root.children
			.map((key) => view.agents.get(key))
			.filter(Boolean)
			.sort((x, y) => x.start - y.start);
		const running = children.filter((child) => child.status === "running").length;
		return el(
			"div",
			{ class: "turn" },
			el("div", { class: "root-row" }, agentCard(view, root)),
			children.length
				? [
						el(
							"div",
							{ class: "connector" },
							el(
								"span",
								{ class: "connector-label" },
								`${children.length} delegated · ${maxParallel(children)} in parallel${running ? ` · ${running} running` : ""}`,
							),
						),
						el("div", { class: "children" }, children.map((child) => agentCard(view, child))),
					]
				: null,
		);
	});
	const orphans = view.subagents.filter((agent) => !agent.parentKey);
	if (orphans.length) {
		turns.push(
			el(
				"div",
				{ class: "turn" },
				el("div", { class: "empty-note" }, "subagents whose caller has not reported yet"),
				el("div", { class: "children" }, orphans.map((agent) => agentCard(view, agent))),
			),
		);
	}
	replace("flow", el("div", { class: "turns" }, turns));
	void now;
}

function setupPanel() {
	const status = ui.status ?? {};
	const check = (ok, label) => el("span", {}, el("span", { class: `dot${ok ? " on" : ""}` }), ` ${label}`);
	return el(
		"div",
		{ class: "setup" },
		el(
			"div",
			{ class: "checks" },
			check(status.spans > 0, `OpenTelemetry: ${status.spans ?? 0} span(s)`),
			check(status.hooks > 0, `hooks: ${status.hooks ?? 0} event(s)`),
		),
		el(
			"ol",
			{},
			el("li", {}, "Add these to your VS Code user settings (both harnesses: the chat extension and the agent host):"),
			el(
				"pre",
				{},
				[
					'"github.copilot.chat.otel.enabled": true,',
					'"chat.agentHost.otel.enabled": true,',
					'"chat.agentHost.otel.otlpProtocol": "http/json"',
				].join("\n"),
			),
			el("li", {}, "Quit VS Code completely and reopen it: the agent host reads these settings when it starts."),
			el("li", {}, "Optional: `npm run install-hooks` adds start and stop signals the moment they happen."),
			el("li", {}, `Run an agent. Spans reach http://localhost:${status.otlpPort ?? 4318} a few seconds after each call ends.`),
		),
		status.protobufRefused
			? el("div", { class: "badge warn" }, "Protobuf received: set the protocol to http/json.")
			: null,
	);
}

function renderProgress(view) {
	if (!view) {
		replace("progress", el("div", { class: "empty-note" }, "—"));
		return;
	}
	if (view.todos) {
		const done = view.todos.filter((todo) => /complete|done/i.test(todo.status)).length;
		replace(
			"progress",
			el("div", {}, `${done} of ${view.todos.length} steps done`),
			el("div", { class: "progress-track" }, el("div", { class: "progress-fill", style: { width: `${(done / view.todos.length) * 100}%` } })),
			el(
				"ul",
				{ class: "todos" },
				view.todos.map((todo) => {
					const state = /complete|done/i.test(todo.status) ? "completed" : /progress|active/i.test(todo.status) ? "in-progress" : "pending";
					const mark = { completed: "[x]", "in-progress": "[>]", pending: "[ ]" }[state];
					return el("li", { class: state }, el("span", { class: "todo-mark" }, mark), el("span", {}, todo.title));
				}),
			),
		);
		return;
	}
	const subs = view.subagents;
	const done = subs.filter((agent) => agent.status === "done").length;
	replace(
		"progress",
		el("div", {}, subs.length ? `${done} of ${subs.length} subagents done` : "no subagent started yet"),
		subs.length
			? el("div", { class: "progress-track" }, el("div", { class: "progress-fill", style: { width: `${(done / subs.length) * 100}%` } }))
			: null,
		el(
			"div",
			{ class: "empty-note" },
			view.waitingForUser
				? "The agent handed the turn back: it waits for you."
				: "The agent's todo list shows here when hooks or OTel content capture report it.",
		),
	);
}

function renderRouting(view) {
	if (!view || view.agents.size === 0) {
		replace("routing", el("div", { class: "empty-note" }, "—"));
		$("routing-meta").textContent = "";
		return;
	}
	const alternative = counterfactual(view, ui.pricing);
	$("routing-meta").textContent = alternative ? `vs all on ${shortModel(alternative.baseline)}` : "";
	const summary = alternative
		? el(
				"div",
				{
					class: "routing-summary",
					tip: `If every LLM call had run on ${alternative.baseline}, the root agent's model.\nAn order of magnitude: another model would not spend the same tokens.${alternative.estimatedRate ? "\nThat model has no list price: priced at the rate its own calls were billed." : ""}`,
				},
				el(
					"span",
					{ class: `routing-saving ${alternative.saving >= 0 ? "good" : "critical"}` },
					alternative.saving >= 0
						? `saves ${Math.round(alternative.saving * 100)}%`
						: `costs ${Math.round(-alternative.saving * 100)}% more`,
				),
				el(
					"span",
					{ class: "muted" },
					`${formatCredits(alternative.actual)} actual · ${formatCredits(alternative.alternative)} if all on ${shortModel(alternative.baseline)}${alternative.estimatedRate ? " (est.)" : ""}`,
				),
			)
		: el("div", { class: "empty-note" }, "The comparison needs the root agent's LLM calls: they arrive when its turn ends.");
	const rows = ui.routing.map((row) => {
		const [tone, mark, label] = ROUTING_LABEL[row.status];
		return el(
			"div",
			{
				class: "routing-row",
				tip: `${row.name}\nran on: ${row.actual.join(", ") || "—"}\ndeclared: ${row.declared.join(", ") || "—"}`,
			},
			el("span", { class: "routing-name" }, row.runs > 1 ? `${row.name} ×${row.runs}` : row.name),
			el("span", { class: "routing-models" }, row.actual.map(shortModel).join(", ") || "—"),
			el("span", { class: `status ${tone}` }, `${mark} ${label}`),
		);
	});
	const note = ui.place?.workspace
		? null
		: el(
				"div",
				{ class: "empty-note" },
				"No known workspace defines these agents. Open the folder in VS Code once, or start the monitor with --workspace <path>.",
			);
	replace("routing", summary, el("div", { class: "routing-rows" }, rows), note);
}

function bars(rows, valueOf, labelOf, tipOf) {
	const max = Math.max(...rows.map(valueOf), 0);
	return el(
		"div",
		{ class: "bars" },
		rows.map((row) =>
			el(
				"div",
				{ class: "bar-row", tip: tipOf(row) },
				el("span", { class: "bar-label", title: row.name }, row.name),
				el(
					"div",
					{ class: "bar-track" },
					el("div", { class: "bar-fill", style: { width: max ? `${Math.max(2, (valueOf(row) / max) * 100)}%` : "0%" } }),
				),
				el("span", { class: "bar-value" }, labelOf(row)),
			),
		),
	);
}

function renderCosts(view) {
	if (!view || view.agents.size === 0) {
		replace("cost-agents", el("div", { class: "empty-note" }, "—"));
		replace("cost-models", el("div", { class: "empty-note" }, "—"));
		$("cost-note").textContent = "";
		return;
	}
	const byName = new Map();
	for (const agent of view.agents.values()) {
		const entry = byName.get(agent.name) ?? { name: agent.name, credits: 0, usd: 0, runs: 0, input: 0, output: 0, calls: 0, pending: false };
		if (!agent.done && agent.totals.calls === 0) entry.pending = true;
		entry.credits += agent.totals.credits;
		entry.usd += agent.totals.usd;
		entry.input += agent.totals.input;
		entry.output += agent.totals.output;
		entry.calls += agent.totals.calls;
		entry.runs += 1;
		byName.set(agent.name, entry);
	}
	const agentRows = [...byName.values()]
		.map((row) => ({ ...row, name: row.runs > 1 ? `${row.name} ×${row.runs}` : row.name }))
		.sort((x, y) => y.credits - x.credits);
	$("cost-note").textContent = view.totals.estimated ? "estimated" : "AI credits";
	replace(
		"cost-agents",
		bars(
			agentRows,
			(row) => row.credits,
			(row) => (row.pending && row.calls === 0 ? "pending" : formatCredits(row.credits)),
			(row) => `${row.name}\n${formatCredits(row.credits)} ≈ ${formatUsd(row.usd)}\n${formatTokens(row.input)} in · ${formatTokens(row.output)} out · ${row.calls} LLM calls`,
		),
	);
	const modelRows = [...view.byModel]
		.map(([model, t]) => ({ name: shortModel(model), model, ...t }))
		.sort((x, y) => y.credits - x.credits);
	replace(
		"cost-models",
		bars(
			modelRows,
			(row) => row.credits,
			(row) => `${formatCredits(row.credits)} · ${row.calls}×`,
			(row) => `${row.model}\n${row.calls} calls · ${formatCredits(row.credits)} ≈ ${formatUsd(row.usd)}\ncache ${formatPercent(row.cacheRead, row.input)} of ${formatTokens(row.input)} input`,
		),
	);
}

function timelineRows(view) {
	const rows = [];
	for (const root of view.rootAgents) {
		rows.push(root);
		for (const key of root.children) {
			const child = view.agents.get(key);
			if (child) rows.push(child);
		}
	}
	for (const agent of view.subagents) if (!rows.includes(agent)) rows.push(agent);
	return rows;
}

function renderTimeline(view, now) {
	if (!view || view.agents.size === 0) {
		replace("timeline", el("div", { class: "empty-note" }, "—"));
		return;
	}
	const t0 = view.startedAt;
	const t1 = Math.max(view.live ? now : view.lastActivityAt, t0 + 1000);
	const span = t1 - t0;
	const x = (time) => `${Math.min(100, Math.max(0, ((time - t0) / span) * 100))}%`;
	const w = (from, to) => `${Math.max(0.3, ((Math.min(to, t1) - from) / span) * 100)}%`;
	const grid = el("div", { class: "timeline" });
	for (const agent of timelineRows(view)) {
		const selected = ui.agentKey === agent.key;
		const label = agent.root ? `${agent.label} · t${agent.turn}` : `└ ${agent.label}`;
		grid.append(
			el(
				"div",
				{
					class: `tl-label${selected ? " selected" : ""}`,
					title: label,
					onclick: () => {
						ui.agentKey = selected ? null : agent.key;
						scheduleRender(true);
					},
				},
				label,
			),
		);
		const track = el("div", { class: "tl-track" });
		if (Number.isFinite(agent.start)) {
			const end = agent.done ? agent.end : now;
			track.append(
				el("div", {
					class: "tl-agent",
					style: { left: x(agent.start), width: w(agent.start, end) },
					tip: `${agent.label} · ${agent.status}\n${formatClock(agent.start)} → ${agent.done ? formatClock(agent.end) : "now"} (${formatDuration(agent.durationMs)})`,
				}),
			);
		}
		for (const call of agent.calls) {
			track.append(
				el("div", {
					class: "tl-llm",
					style: { left: x(call.start), width: w(call.start, call.end ?? call.start) },
					tip: `LLM · ${call.model ?? "?"}\n${formatDuration((call.end ?? call.start) - call.start)} · ${formatTokens(call.usage.input)} in / ${formatTokens(call.usage.output)} out\n${formatCredits(call.usage.credits)}`,
				}),
			);
		}
		for (const tool of agent.tools) {
			track.append(
				el("div", { class: "tl-tool", style: { left: x(tool.start) } }),
				el("div", {
					class: "tl-hit",
					style: { left: x(tool.start) },
					tip: `tool · ${tool.name}${tool.summary ? `\n${tool.summary}` : ""}\n${formatDuration((tool.end ?? tool.start) - tool.start)}${tool.permission ? ` · ${tool.permission}` : ""}${tool.failed ? " · failed" : ""}`,
				}),
			);
		}
		if (view.live) track.append(el("div", { class: "tl-now", style: { left: x(now) } }));
		grid.append(track);
	}
	const axis = el("div", { class: "tl-axis" });
	for (let i = 0; i <= 4; i += 1) {
		const offset = (span * i) / 4;
		axis.append(el("span", { style: { left: `${i * 25}%` } }, i === 0 ? "0s" : `+${formatDuration(offset)}`));
	}
	grid.append(el("div"), axis);
	replace("timeline", grid);
}

function logEntries(view) {
	const entries = [...view.log];
	for (const agent of view.agents.values()) {
		if (Number.isFinite(agent.start)) entries.push({ time: agent.start, type: "agent-start", agentKey: agent.key, agent });
		if (agent.done && agent.end) entries.push({ time: agent.end, type: "agent-end", agentKey: agent.key, agent });
	}
	entries.sort((x, y) => x.time - y.time);
	return ui.agentKey ? entries.filter((entry) => entry.agentKey === ui.agentKey) : entries;
}

function logRow(view, entry) {
	const agent = entry.agentKey ? view.agents.get(entry.agentKey) : null;
	const who = agent ? agent.label : "—";
	let what = "";
	let detail = "";
	let cost = "";
	let kind = "";
	if (entry.type === "llm") {
		const u = entry.call.usage;
		kind = "llm";
		what = "llm";
		detail = `${shortModel(entry.call.model)} · ${formatTokens(u.input)} in / ${formatTokens(u.output)} out${u.cacheRead ? ` · cache ${formatPercent(u.cacheRead, u.input)}` : ""} · ${formatDuration((entry.call.end ?? entry.call.start) - entry.call.start)}`;
		cost = formatCredits(u.credits);
	} else if (entry.type === "tool") {
		const tool = entry.tool;
		kind = "tool";
		what = "tool";
		detail = [tool.name, tool.summary, tool.permission, tool.failed ? "failed" : null, formatDuration((tool.end ?? tool.start) - tool.start)]
			.filter(Boolean)
			.join(" · ");
	} else if (entry.type === "agent-start") {
		kind = "agent";
		what = "start";
		detail = entry.agent.root ? `turn ${entry.agent.turn}` : `delegated${entry.agent.brief ? ` · ${entry.agent.brief}` : ""}`;
	} else if (entry.type === "agent-end") {
		kind = "agent";
		what = entry.agent.status;
		detail = `${formatDuration(entry.agent.durationMs)} · ${entry.agent.totals.calls} LLM calls · ${entry.agent.toolCount} tools`;
		cost = formatCredits(entry.agent.totals.credits);
	} else if (entry.type === "hook-tool") {
		kind = "tool";
		what = "hook";
		detail = [entry.hook.phase, entry.hook.tool, entry.hook.summary].filter(Boolean).join(" · ");
	}
	return el(
		"div",
		{ class: "log-row" },
		el("span", { class: "when" }, formatClock(entry.time)),
		el("span", { class: "who", title: who }, who),
		el("span", { class: `what ${kind}` }, what),
		el("span", { class: "detail", title: detail }, detail),
		el("span", { class: "cost" }, cost),
	);
}

function renderLog(view) {
	const log = $("log");
	if (!view) {
		log.replaceChildren(el("div", { class: "empty-note" }, "—"));
		$("log-meta").textContent = "";
		return;
	}
	const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
	const entries = logEntries(view);
	const shown = entries.slice(-500);
	const agent = ui.agentKey ? view.agents.get(ui.agentKey) : null;
	$("log-meta").textContent = `${agent ? `${agent.label} only · ` : ""}${entries.length} event${entries.length === 1 ? "" : "s"}${entries.length > shown.length ? ` · last ${shown.length}` : ""}`;
	log.replaceChildren(...shown.map((entry) => logRow(view, entry)));
	if (stick) log.scrollTop = log.scrollHeight;
}

function renderStatusline(view) {
	if (!view) {
		replace("statusline", el("span", { class: "prompt" }, "~/agents $"), el("span", {}, "idle"));
		return;
	}
	const agents = [...view.agents.values()].sort((x, y) => x.start - y.start).slice(-8);
	replace(
		"statusline",
		el("span", { class: "prompt" }, "~/agents $"),
		agents.map((agent) => el("span", {}, `${agent.label} [${agent.status}]`)),
		el("span", {}, `cost [${formatCredits(view.totals.credits)}]`),
	);
}

// ---------------------------------------------------------------------------------------------
// History (lot 3): sessions kept by the server, grouped by ticket.

const NO_TICKET = "no ticket";

function historyInScope() {
	const workspace = $("history-workspace").value;
	const days = Number($("history-period").value);
	const since = days ? Date.now() - days * 86_400_000 : 0;
	return ui.history.filter(
		(summary) => summary.startedAt >= since && (!workspace || summary.workspace === workspace),
	);
}

function renderHistoryFilters() {
	const select = $("history-workspace");
	const current = select.value;
	const names = new Map();
	for (const summary of ui.history) if (summary.workspace) names.set(summary.workspace, summary.workspaceName);
	const signature = [...names.keys()].join("\n");
	if (select.dataset.signature !== signature) {
		select.dataset.signature = signature;
		select.replaceChildren(
			el("option", { value: "" }, "all workspaces"),
			...[...names].map(([path, name]) => el("option", { value: path, title: path }, name)),
		);
		select.value = names.has(current) ? current : "";
	}
}

function groupByTicket(summaries) {
	const tickets = new Map();
	for (const summary of summaries) {
		const key = summary.ticket ?? NO_TICKET;
		const entry = tickets.get(key) ?? {
			ticket: key,
			branches: new Set(),
			sessions: 0,
			first: Number.POSITIVE_INFINITY,
			last: 0,
			wallMs: 0,
			credits: 0,
			usd: 0,
			baseline: 0,
			baselineSessions: 0,
			agents: new Map(),
		};
		if (summary.branch) entry.branches.add(summary.branch);
		entry.sessions += 1;
		entry.first = Math.min(entry.first, summary.startedAt);
		entry.last = Math.max(entry.last, summary.lastActivityAt);
		entry.wallMs += summary.wallMs;
		entry.credits += summary.totals.credits;
		entry.usd += summary.totals.usd;
		if (summary.baseline) {
			entry.baseline += summary.baseline.credits;
			entry.baselineSessions += 1;
		}
		for (const [name, agent] of Object.entries(summary.byAgent ?? {})) {
			entry.agents.set(name, (entry.agents.get(name) ?? 0) + agent.credits);
		}
		tickets.set(key, entry);
	}
	return [...tickets.values()].sort((x, y) => y.last - x.last);
}

function savingOf(entries) {
	const priced = entries.filter((entry) => entry.baseline > 0);
	const actual = priced.reduce((sum, entry) => sum + entry.credits, 0);
	const baseline = priced.reduce((sum, entry) => sum + entry.baseline, 0);
	return baseline > 0 ? 1 - actual / baseline : null;
}

function table(headers, rows) {
	return el(
		"table",
		{ class: "data" },
		el("thead", {}, el("tr", {}, headers.map(([label, numeric]) => el("th", { class: numeric ? "num" : null, scope: "col" }, label)))),
		el("tbody", {}, rows),
	);
}

function renderHistory() {
	// Rebuilding the table drops the focus: give it back to the row that had it.
	const focused = document.activeElement?.closest?.("#history-tickets tr[data-ticket]")?.dataset.ticket;
	renderTicketsAndSessions();
	if (focused) document.querySelector(`#history-tickets tr[data-ticket="${CSS.escape(focused)}"]`)?.focus();
}

function renderTicketsAndSessions() {
	renderHistoryFilters();
	const summaries = historyInScope();
	const tickets = groupByTicket(summaries);
	const total = summaries.reduce((sum, summary) => sum + summary.totals.credits, 0);
	const totalUsd = summaries.reduce((sum, summary) => sum + summary.totals.usd, 0);
	const withTicket = tickets.filter((entry) => entry.ticket !== NO_TICKET);
	const saving = savingOf(summaries.map((summary) => ({ credits: summary.totals.credits, baseline: summary.baseline?.credits ?? 0 })));
	replace(
		"history-kpis",
		kpi("cost", formatCredits(total), `≈ ${formatUsd(totalUsd)}`, true),
		kpi("sessions", String(summaries.length), `${formatDuration(summaries.reduce((sum, s) => sum + s.wallMs, 0))} of agent time`),
		kpi("tickets", String(withTicket.length), withTicket.length ? `${formatCredits(withTicket.reduce((sum, t) => sum + t.credits, 0) / withTicket.length)} per ticket` : "no branch named after a ticket"),
		kpi("routing", saving == null ? "—" : `${Math.round(saving * 100)}%`, saving == null ? "no baseline yet" : "saved vs all on the root model"),
	);

	if (summaries.length === 0) {
		const note = el(
			"div",
			{ class: "empty-note" },
			"No session in this period. A session is summarized here once it has been quiet for 30 seconds.",
		);
		replace("history-tickets", note);
		replace("history-ticket-bars", el("div", { class: "empty-note" }, "—"));
		replace("history-agent-bars", el("div", { class: "empty-note" }, "—"));
		replace("history-sessions", el("div", { class: "empty-note" }, "—"));
		$("history-sessions-meta").textContent = "";
		return;
	}

	replace(
		"history-tickets",
		table(
			[["ticket"], ["branch"], ["sessions", true], ["last activity"], ["agent time", true], ["cost", true], ["saved", true], ["top agent"]],
			tickets.map((entry) => {
				const top = [...entry.agents].sort((x, y) => y[1] - x[1])[0];
				const rowSaving = entry.baseline > 0 ? 1 - entry.credits / entry.baseline : null;
				const selected = ui.historyTicket === entry.ticket;
				return el(
					"tr",
					{
						class: selected ? "selected" : null,
						"data-ticket": entry.ticket,
						tabindex: "0",
						"aria-selected": selected ? "true" : "false",
						onclick: () => {
							ui.historyTicket = selected ? null : entry.ticket;
							scheduleRender(true);
						},
						onkeydown: (event) => {
							if (event.key === "Enter" || event.key === " ") {
								event.preventDefault();
								ui.historyTicket = selected ? null : entry.ticket;
								scheduleRender(true);
							}
						},
					},
					el("td", { class: "strong" }, entry.ticket),
					el("td", { class: "ellipsis", title: [...entry.branches].join(", ") }, [...entry.branches].join(", ") || "—"),
					el("td", { class: "num" }, String(entry.sessions)),
					el("td", {}, new Date(entry.last).toLocaleString([], { dateStyle: "short", timeStyle: "short" })),
					el("td", { class: "num" }, formatDuration(entry.wallMs)),
					el("td", { class: "num", title: `≈ ${formatUsd(entry.usd)}` }, formatCredits(entry.credits)),
					el("td", { class: "num" }, rowSaving == null ? "—" : `−${Math.round(rowSaving * 100)}%`),
					el("td", {}, top ? `${top[0]} (${formatPercent(top[1], entry.credits)})` : "—"),
				);
			}),
		),
	);

	replace(
		"history-ticket-bars",
		bars(
			[...tickets].sort((x, y) => y.credits - x.credits).slice(0, 12).map((entry) => ({ ...entry, name: entry.ticket })),
			(row) => row.credits,
			(row) => formatCredits(row.credits),
			(row) => `${row.ticket}\n${row.sessions} session(s) · ${formatCredits(row.credits)} ≈ ${formatUsd(row.usd)}`,
		),
	);

	const agentTotals = new Map();
	for (const summary of summaries) {
		for (const [name, agent] of Object.entries(summary.byAgent ?? {})) {
			agentTotals.set(name, (agentTotals.get(name) ?? 0) + agent.credits);
		}
	}
	replace(
		"history-agent-bars",
		bars(
			[...agentTotals].map(([name, credits]) => ({ name, credits })).sort((x, y) => y.credits - x.credits),
			(row) => row.credits,
			(row) => `${formatCredits(row.credits)} · ${formatPercent(row.credits, total)}`,
			(row) => `${row.name}\n${formatCredits(row.credits)} over the period`,
		),
	);

	const listed = ui.historyTicket
		? summaries.filter((summary) => (summary.ticket ?? NO_TICKET) === ui.historyTicket)
		: summaries;
	$("history-sessions-meta").textContent = ui.historyTicket
		? `${ui.historyTicket} · ${listed.length} session(s)`
		: `${listed.length} session(s)`;
	replace(
		"history-sessions",
		table(
			[["started"], ["ticket"], ["workspace"], ["root agent"], ["agents", true], ["wall clock", true], ["tokens in", true], ["cost", true], [""]],
			listed.map((summary) => {
				const loaded = store.sessions.has(summary.id);
				return el(
					"tr",
					{},
					el("td", {}, new Date(summary.startedAt).toLocaleString([], { dateStyle: "short", timeStyle: "short" })),
					el("td", { title: summary.branch ?? "" }, `${summary.ticket ?? "—"}${summary.branchGuessed ? " ~" : ""}`),
					el("td", { class: "ellipsis", title: summary.workspace ?? "" }, summary.workspaceName ?? "—"),
					el("td", { class: "ellipsis", title: summary.prompt ?? "" }, summary.title),
					el("td", { class: "num" }, String(summary.agents)),
					el("td", { class: "num" }, formatDuration(summary.wallMs)),
					el("td", { class: "num" }, formatTokens(summary.totals.input)),
					el("td", { class: "num", title: `≈ ${formatUsd(summary.totals.usd)}` }, `${formatCredits(summary.totals.credits)}${summary.totals.estimated ? " est." : ""}`),
					el(
						"td",
						{},
						loaded
							? el(
									"button",
									{
										type: "button",
										class: "link",
										onclick: () => {
											ui.sessionId = summary.id;
											ui.follow = false;
											$("follow").checked = false;
											setView("live");
										},
									},
									"open",
								)
							: null,
					),
				);
			}),
		),
	);
}

function setView(view) {
	ui.view = view;
	for (const button of document.querySelectorAll("[data-view]")) {
		button.setAttribute("aria-pressed", String(button.dataset.view === view));
	}
	$("app").hidden = view !== "live";
	$("history").hidden = view !== "history";
	for (const node of document.querySelectorAll(".live-only")) node.hidden = view !== "live";
	if (view === "history") refreshHistory();
	scheduleRender(true);
}

// ---------------------------------------------------------------------------------------------
// Render loop.

function currentViews(now) {
	return [...store.sessions.values()]
		.map((session) => summaryOf(session, now))
		.filter((view) => view.agents.size > 0 || view.log.length > 0)
		.sort((x, y) => y.lastActivityAt - x.lastActivityAt);
}

/** While the history shows, the top bar and the status line still follow the latest session. */
function renderLiveSummary(now) {
	const latest = currentViews(now)[0] ?? null;
	renderLive(latest, now);
	renderStatusline(latest);
}

function render() {
	ui.renderQueued = false;
	ui.lastRenderAt = performance.now();
	const now = Date.now();
	if (ui.view === "history") {
		renderHistory();
		renderLiveSummary(now);
		return;
	}
	const views = currentViews(now);
	if (ui.follow || !views.some((view) => view.id === ui.sessionId)) {
		ui.sessionId = views[0]?.id ?? null;
	}
	renderSessionPicker(views);
	const view = views.find((candidate) => candidate.id === ui.sessionId) ?? null;
	if (ui.agentKey && !view?.agents.has(ui.agentKey)) ui.agentKey = null;
	ui.place = view ? placeOf(view, ui.workspaces) : null;
	ui.routing = view ? routingFor(view, definitionsOf(ui.place?.workspace)) : [];
	renderLive(view, now);
	renderKpis(view);
	renderFlow(view, now);
	renderProgress(view);
	renderRouting(view);
	renderCosts(view);
	renderTimeline(view, now);
	renderLog(view);
	renderStatusline(view);
	document.title = view?.live ? `● ${view.title} · Agent Monitor` : "Agent Monitor";
}

function scheduleRender(immediate = false) {
	if (ui.renderQueued) return;
	ui.renderQueued = true;
	const wait = immediate ? 0 : Math.max(0, 250 - (performance.now() - ui.lastRenderAt));
	setTimeout(() => requestAnimationFrame(render), wait);
}

// ---------------------------------------------------------------------------------------------
// Wiring.

$("session-select").addEventListener("change", (event) => {
	ui.sessionId = event.target.value;
	ui.follow = false;
	ui.agentKey = null;
	$("follow").checked = false;
	scheduleRender(true);
});

$("follow").addEventListener("change", (event) => {
	ui.follow = event.target.checked;
	scheduleRender(true);
});

const tooltip = $("tooltip");
document.addEventListener("mousemove", (event) => {
	const target = event.target instanceof Element ? event.target.closest("[data-tip]") : null;
	if (!target) {
		tooltip.hidden = true;
		return;
	}
	tooltip.textContent = target.dataset.tip;
	tooltip.hidden = false;
	const { innerWidth, innerHeight } = window;
	const box = tooltip.getBoundingClientRect();
	tooltip.style.left = `${Math.min(event.clientX + 14, innerWidth - box.width - 8)}px`;
	tooltip.style.top = `${Math.min(event.clientY + 14, innerHeight - box.height - 8)}px`;
});

for (const button of document.querySelectorAll("[data-view]")) {
	button.addEventListener("click", () => setView(button.dataset.view));
}
for (const id of ["history-workspace", "history-period"]) {
	$(id).addEventListener("change", () => {
		ui.historyTicket = null;
		scheduleRender(true);
	});
}

async function getJson(path) {
	const response = await fetch(path);
	if (!response.ok) throw new Error(`${path}: ${response.status}`);
	return response.json();
}

async function refreshStatus() {
	try {
		ui.status = await getJson("/api/status");
	} catch {
		// The stream's own error handler reports the disconnection.
	}
}

async function refreshWorkspaces() {
	try {
		ui.workspaces = await getJson("/api/workspaces");
		summaries.clear();
		ui.sessionsSignature = "";
		scheduleRender();
	} catch {
		// Kept from the last refresh.
	}
}

async function refreshHistory() {
	try {
		const history = await getJson("/api/history");
		const changed = JSON.stringify(history) !== JSON.stringify(ui.history);
		ui.history = history;
		if (changed) scheduleRender();
	} catch {
		// Kept from the last refresh.
	}
}

async function start() {
	try {
		ui.pricing = await getJson("/api/config");
	} catch {
		ui.pricing = null;
	}
	await Promise.all([refreshStatus(), refreshWorkspaces()]);
	setInterval(refreshWorkspaces, 30_000);
	setInterval(() => {
		if (ui.view === "history") refreshHistory();
	}, 15_000);
	const stream = new EventSource("/api/stream");
	stream.onopen = () => {
		ui.connected = true;
		scheduleRender(true);
	};
	stream.onerror = () => {
		ui.connected = false;
		scheduleRender(true);
	};
	stream.onmessage = (message) => {
		ingest(store, JSON.parse(message.data));
		// The history redraws only when its own data or filters change: a table rebuilt every
		// second would lose the row under the pointer and the keyboard focus.
		if (ui.view === "live") scheduleRender();
	};
	setInterval(() => {
		if (store.sessions.size === 0) refreshStatus();
		if (ui.view === "live") scheduleRender();
		else renderLiveSummary(Date.now());
	}, 1000);
	scheduleRender(true);
}

start();
