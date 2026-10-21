import {
	formatClock,
	formatCredits,
	formatDuration,
	formatPercent,
	formatTokens,
	formatUsd,
	shortModel,
} from "./format.js";
import { TARGETS, sessionIndicators } from "./indicators.js";
import { createStore, deriveSession, handoffOf, ingest, mcpLabel } from "./model.js";
import { countTo, flash, motionAllowed, reconcile, sendPacket, typeInto } from "./motion.js";
import { createLinkLayer } from "./links.js";
import { childrenOf, groupWaves, launchOf, readerOf, turnTag, turnTitle } from "./tree.js";
import { counterfactual, routingFor } from "./routing.js";
import { definitionsOf, placeOf } from "./workspaces.js";

const store = createStore();
const ui = {
	view: "live",
	pricing: null,
	// MCP server names by the SHA-256 Copilot reports them as, from the server.
	mcpNames: {},
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
	// The lines whose messages show beside the tree: `{ kind, keys }`, kind "launch" or "ret",
	// several keys when the line clicked is a stretch that several agents' lines share.
	link: null,
	// The session shown, as last derived.
	session: null,
	renderQueued: false,
	lastRenderAt: 0,
	sessionsSignature: "",
	// The hooks' time of each session, from Copilot's journal, as the server last read it.
	journal: new Map(),
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

// ---------------------------------------------------------------------------------------------
// Sessions.

function summaryOf(session, now) {
	const cached = summaries.get(session.id);
	if (cached && cached.version === session.version && !cached.view.live) return cached.view;
	const view = deriveSession(session, { now, pricing: ui.pricing, mcpNames: ui.mcpNames });
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

/** Output tokens per second over the last minute: how fast the agents are writing. */
function throughput(view, now) {
	let tokens = 0;
	for (const agent of view.agents.values()) {
		for (const call of agent.calls) if (now - (call.end ?? 0) < 60_000) tokens += call.usage.output;
	}
	return tokens / 60;
}

// The indicator keeps its elements: rebuilt every second, the dot's pulse would restart each time.
const liveDot = el("span", { class: "dot" });
const liveText = el("span");
$("live").replaceChildren(liveDot, liveText);

function renderLive(view, now) {
	const lag = store.lastLagMs != null ? ` · lag ${formatDuration(Math.max(0, store.lastLagMs))}` : "";
	let tone = "";
	let text;
	if (!ui.connected) {
		tone = "bad";
		text = "monitor disconnected — retrying";
	} else if (!view) {
		text = "waiting for the first event";
	} else if (view.live) {
		tone = "on";
		const rate = throughput(view, now);
		text = `LIVE · ${view.running.length} running${rate >= 1 ? ` · ${Math.round(rate)} tok/s` : ""}${lag}`;
	} else if (view.waitingForUser) {
		tone = "on";
		text = "waiting for your answer";
	} else {
		text = `idle · last activity ${formatDuration(now - view.lastActivityAt)} ago${lag}`;
	}
	const className = `dot${tone ? ` ${tone}` : ""}`;
	if (liveDot.className !== className) liveDot.className = className;
	liveText.textContent = text;
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

/** The live tiles keep their elements, so a value counts up to the next one instead of jumping. */
const liveTiles = (() => {
	const tiles = {};
	const specs = [
		["cost", "cost", true],
		["wall", "wall clock"],
		["agents", "agents"],
		["tokens", "tokens"],
		["cache", "cache"],
		["calls", "llm calls"],
		["tools", "tool calls"],
	];
	$("kpis").replaceChildren(
		...specs.map(([key, label, accent]) => {
			const value = el("div", { class: `kpi-value${accent ? " accent" : ""}` }, "—");
			const sub = el("div", { class: "kpi-sub" });
			tiles[key] = { value, sub };
			return el("div", { class: "kpi" }, el("div", { class: "kpi-label" }, label), value, sub);
		}),
	);
	return tiles;
})();

function setTile(key, value, sub, format) {
	const tile = liveTiles[key];
	if (format) countTo(tile.value, value, format);
	else {
		tile.value._value = null;
		tile.value.textContent = value;
	}
	tile.sub.textContent = sub;
	tile.sub.title = sub;
}

function renderKpis(view) {
	if (!view) {
		for (const key of Object.keys(liveTiles)) setTile(key, "—", key === "cost" ? "no session yet" : "");
		return;
	}
	const t = view.totals;
	const costSub = t.unpriced
		? `${formatUsd(t.usd)} · ${t.unpriced} call(s) unpriced`
		: t.estimated
			? `≈ ${formatUsd(t.usd)} · estimated from list prices`
			: `≈ ${formatUsd(t.usd)} · billed by Copilot`;
	const parallel = maxParallel(view.subagents);
	setTile("cost", t.credits, costSub, formatCredits);
	setTile("wall", formatDuration(view.wallMs), `${view.turns} turn${view.turns === 1 ? "" : "s"}`);
	setTile("agents", `${view.running.length} / ${view.agents.size}`, `running / total · ${parallel} max in parallel`);
	setTile("tokens", t.input, `${formatTokens(t.output)} out · ${formatTokens(t.reasoning)} reasoning`, (n) => `${formatTokens(Math.round(n))} in`);
	setTile(
		"cache",
		t.input ? (t.cacheRead / t.input) * 100 : 0,
		`${formatTokens(t.cacheRead)} read · ${formatTokens(t.cacheWrite)} written`,
		(n) => (t.input ? `${Math.round(n)}%` : "—"),
	);
	setTile("calls", t.calls, `${view.byModel.size} model${view.byModel.size === 1 ? "" : "s"}`, (n) => String(Math.round(n)));
	setTile("tools", view.toolCount, view.prompt ? `“${view.prompt.slice(0, 60)}”` : view.cwd ?? "", (n) => String(Math.round(n)));
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

/** The model family a badge's dot shows: Haiku finds, Sonnet builds, Opus decides. */
function modelFamily(model) {
	return /opus|fable|mythos/i.test(model) ? "opus" : /sonnet/i.test(model) ? "sonnet" : /haiku/i.test(model) ? "haiku" : "other";
}

/** Whose MCP server it is, for its badge's dot: GitHub's, Atlassian's, or another. */
function mcpFamily(server) {
	return /github/i.test(server ?? "") ? "github" : /atlassian|jira|confluence/i.test(server ?? "") ? "atlassian" : "other";
}

function mcpBadge(entry, text = mcpLabel(entry)) {
	const title = `MCP server ${mcpLabel(entry)}${entry.hash && !entry.server ? `\nSHA-256 ${entry.hash}\nname it in .vscode/mcp.json or ~/.copilot/mcp-config.json` : ""}`;
	return el("span", { class: `badge mcp mcp-${mcpFamily(entry.server)}`, title }, text);
}

/** What tool results cost once read: an estimate, always shown as one. */
function formatContext(tokens, credits) {
	return `≈ ${formatTokens(tokens)} tok${credits ? ` · ${formatCredits(credits)}` : ""}`;
}

/** The MCP servers an agent called, and what their results cost it: tokens, credits. */
function mcpTotals(entries) {
	return entries.reduce(
		(sum, entry) => ({
			calls: sum.calls + entry.calls,
			tokens: sum.tokens + entry.tokens,
			credits: sum.credits + entry.credits,
			costed: sum.costed + entry.costed,
		}),
		{ calls: 0, tokens: 0, credits: 0, costed: 0 },
	);
}

function createCard() {
	const refs = {
		name: el("span", { class: "card-name" }),
		tag: el("span", { class: "card-tag" }),
		status: el("span", { class: "status" }),
		models: el("span", { class: "card-models" }),
		duration: el("span"),
		tokens: el("span"),
		cost: el("span", { class: "card-cost" }),
		foot: el("div", { class: "card-foot" }),
		delegation: el("div", { class: "card-delegation" }),
		mcp: el("div", { class: "card-mcp" }),
	};
	const card = el(
		"button",
		{ type: "button", class: "card" },
		el("div", { class: "card-top" }, el("span", { class: "card-who" }, refs.name, refs.tag), refs.status),
		el("div", { class: "card-line" }, refs.models, refs.duration),
		el("div", { class: "card-line" }, refs.tokens, refs.cost),
		refs.delegation,
		refs.mcp,
		refs.foot,
		el("div", { class: "card-activity", "aria-hidden": "true" }),
	);
	card._refs = refs;
	card.setAttribute("aria-controls", "tools-panel");
	card.addEventListener("click", () => {
		ui.agentKey = ui.agentKey === card.dataset.key ? null : card.dataset.key;
		ui.link = null;
		// On a narrow screen the panel lies below the tree: bring it into view.
		ui.reveal = ui.agentKey != null;
		scheduleRender(true);
	});
	return card;
}

function updateCard(card, agent, isNew) {
	const refs = card._refs;
	const routing = ui.routing.find((row) => row.name === agent.name);
	const flagged = routing && (routing.status === "fallback" || routing.status === "off-list");
	const selected = ui.agentKey === agent.key;

	// classList, not className: a one-shot animation class may be running on the card.
	for (const status of Object.keys(STATUS_MARK)) card.classList.toggle(status, agent.status === status);
	card.classList.toggle("selected", selected);
	card.setAttribute("aria-pressed", String(selected));
	if (isNew && ui.animateFlow) flash(card, "entering");
	if (card._status === "running" && agent.status === "done") {
		flash(card, "just-done");
		// Remembered, so that its return line advances for a few seconds.
		card._doneAt = performance.now();
	}
	card._status = agent.status;

	refs.name.textContent = agent.unnamed ? `${agent.label} · identifying…` : agent.label;
	// A root agent shows its turn; any other shows who launched it and how far into that turn.
	refs.tag.textContent = agent.root
		? turnTag(agent)
		: agent._launcher
			? `↳ ${agent._launcher}${agent._offset ? ` · ${agent._offset}` : ""}`
			: "";
	// Where its answer is read, when that is not the agent that launched it: the lines are drawn from this.
	if (agent.returnKey && agent.returnKey !== agent.parentKey) card.dataset.returnTo = agent.returnKey;
	else delete card.dataset.returnTo;
	refs.tag.title = agent.root
		? turnTitle(agent)
		: agent._launcher
			? `Launched by ${agent._launcher}${agent._offset ? `, ${agent._offset} into its turn` : ""}`
			: "";
	refs.delegation.textContent = agent._delegation ?? "";
	refs.delegation.hidden = !agent._delegation;
	updateCardMcp(refs.mcp, agent);
	refs.status.className = `status ${agent.status}`;
	refs.status.textContent = `${STATUS_MARK[agent.status] ?? "·"} ${agent.status}`;

	const models = [...agent.models];
	const signature = `${models.join("|")}|${flagged ? routing.status : ""}`;
	if (refs.models.dataset.signature !== signature) {
		refs.models.dataset.signature = signature;
		refs.models.replaceChildren(
			...(models.length
				? models.map((model) =>
						el(
							"span",
							{
								class: `badge m-${modelFamily(model)}${flagged ? " warn" : ""}`,
								title: flagged ? `${ROUTING_LABEL[routing.status][2]} · declared: ${routing.declared.join(", ")}` : model,
							},
							shortModel(model),
						),
					)
				: [el("span", { class: "muted" }, agent.root && !agent.done ? "LLM calls reported at turn end" : "no model yet")]),
		);
	}
	refs.duration.textContent = formatDuration(agent.durationMs);
	const t = agent.totals;
	refs.tokens.textContent = `${formatTokens(t.input)} in · ${formatTokens(t.output)} out`;
	if (t.priced || t.credits) countTo(refs.cost, t.credits, formatCredits);
	else refs.cost.textContent = "—";
	const last = agent.lastTool
		? `last ${agent.lastTool.name}${agent.lastTool.summary ? ` · ${agent.lastTool.summary}` : ""}${agent.lastTool.permission ? ` · ${agent.lastTool.permission}` : ""}`
		: null;
	const foot = [`${agent.toolCount} tool${agent.toolCount === 1 ? "" : "s"}`, agent.brief ?? last ?? agent.description]
		.filter(Boolean)
		.join(" · ");
	if (refs.foot.textContent !== foot) {
		refs.foot.textContent = foot;
		refs.foot.title = foot;
		// A new tool call: the line flickers, as a terminal line being rewritten.
		if (!isNew && agent.status === "running") flash(refs.foot, "rewritten");
	}
}

/** The card's MCP line: each server the agent called, how often, and what the results cost. */
function updateCardMcp(line, agent) {
	const signature = agent.mcp.map((entry) => `${entry.key}:${entry.calls}:${entry.tokens}:${entry.credits}`).join("|");
	if (line.dataset.signature === signature) return;
	line.dataset.signature = signature;
	line.hidden = agent.mcp.length === 0;
	if (line.hidden) return line.replaceChildren();
	const total = mcpTotals(agent.mcp);
	line.title = agent.mcp
		.map((entry) => `${mcpLabel(entry)}: ${[...entry.tools].map(([tool, count]) => (count > 1 ? `${tool} ×${count}` : tool)).join(", ")}`)
		.join("\n");
	line.replaceChildren(
		el("span", { class: "card-mcp-label" }, "mcp"),
		...agent.mcp.map((entry) => mcpBadge(entry, `${mcpLabel(entry)} ×${entry.calls}`)),
		total.costed ? el("span", { class: "card-mcp-cost", title: "Tokens their results added to the context, and what reading them cost: an estimate" }, formatContext(total.tokens, total.credits)) : null,
	);
}

/** One node of the tree: a card and, below it, the agents it launched, a wave at a time. */
function createNode() {
	const node = el("div", { class: "node" });
	node._refs = { slot: el("div", { class: "slot" }), kids: el("div", { class: "kids" }) };
	node.append(node._refs.slot, node._refs.kids);
	return node;
}

/** Agents that ran side by side: a row, or several when they do not fit. */
function createWave() {
	return el("div", { class: "wave" });
}

/** An agent in a wave: its card and, below it, the agents it launched in turn. */
function createCell() {
	const cell = el("div", { class: "cell" });
	cell._node = createNode();
	cell.append(cell._node);
	return cell;
}

function createTurn() {
	const turn = el("div", { class: "turn" });
	turn._node = createNode();
	turn.append(turn._node);
	return turn;
}

function updateNode(node, view, agent, now) {
	const refs = node._refs;
	const kids = childrenOf(view, agent);
	const running = kids.filter((kid) => kid.status === "running").length;

	if (agent.virtual) {
		if (!refs.slot.firstChild) {
			refs.slot.append(el("div", { class: "empty-note" }, "These subagents report before the agent that launched them."));
		}
	} else {
		agent._delegation = kids.length
			? `${kids.length} launched · ${maxParallel(kids)} max in parallel${running ? ` · ${running} running` : ""}`
			: "";
		reconcile(refs.slot, [agent], (item) => item.key, createCard, updateCard);
	}
	node.classList.toggle("leaf", kids.length === 0);
	refs.kids.hidden = kids.length === 0;

	for (const kid of kids) {
		const { launcher, offset } = launchOf(agent, kid);
		kid._launcher = launcher;
		kid._offset = offset;
	}
	reconcile(refs.kids, groupWaves(kids, now), (wave) => wave.key, createWave, (waveElement, wave) =>
		reconcile(waveElement, wave.agents, (kid) => kid.key, createCell, (cell, kid) => {
			// An agent with agents of its own takes a whole row, so that they have the room below it.
			cell.classList.toggle("has-kids", kid.children.some((key) => view.agents.has(key)));
			updateNode(cell._node, view, kid, now);
		}),
	);
}

/** Remembers, per session, what each agent was at the last render: packets fly on changes only. */
const flowMemory = { sessionId: null, agents: new Map() };

const flow = $("flow");
const flowBody = el("div", { class: "flow-body" });
flow.replaceChildren(flowBody);
const linkLayer = createLinkLayer(flow);
// The lines follow the layout: a resized panel moves every card.
new ResizeObserver(() => {
	if (flowMemory.sessionId) linkLayer.update();
}).observe(flowBody);

function renderFlow(view) {
	if (!view) {
		flowBody.replaceChildren(setupPanel());
		linkLayer.clear();
		$("flow-meta").textContent = "";
		flowMemory.sessionId = null;
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

	const sameSession = flowMemory.sessionId === view.id;
	if (!sameSession) {
		flowMemory.sessionId = view.id;
		flowMemory.agents = new Map();
		flowBody.replaceChildren();
		linkLayer.clear();
	}
	// Cards and packets animate for what happens now, not for a session being opened.
	ui.animateFlow = sameSession;
	let turns = flowBody.querySelector(":scope > .turns");
	if (!turns) {
		turns = el("div", { class: "turns" });
		flowBody.replaceChildren(turns);
	}

	const now = Date.now();
	const items = [...view.rootAgents];
	const orphans = view.subagents.filter((agent) => !agent.parentKey);
	if (orphans.length) items.push({ key: "orphans", virtual: true, children: orphans.map((agent) => agent.key), start: orphans[0].start });
	reconcile(turns, items, (item) => item.key, createTurn, (turn, item) => {
		// A run started to read its predecessor's subagents continues that turn: no divider between them.
		turn.classList.toggle("resume", Boolean(item.resumeOf));
		updateNode(turn._node, view, item, now);
	});

	// The lines are drawn once the cards are in place.
	const routes = linkLayer.update({
		selected: ui.link ? ui.link.keys.map((key) => `${ui.link.kind === "ret" ? "R" : "L"}:${key}`) : [],
		describe: (kind, key) => describeLines(view, kind, [key]),
	});

	// Packets: one goes out along the launch line to a new subagent, one comes back along its
	// return line when it finishes.
	const packets = [];
	for (const agent of view.agents.values()) {
		if (agent.root || !agent.parentKey) continue;
		const before = flowMemory.agents.get(agent.key);
		if (sameSession && !before) packets.push({ agent, back: false });
		else if (sameSession && before === "running" && agent.status === "done") packets.push({ agent, back: true });
	}
	for (const agent of view.agents.values()) flowMemory.agents.set(agent.key, agent.status);
	if (packets.length > 0 && packets.length <= 8 && motionAllowed()) {
		for (const [index, { agent, back }] of packets.entries()) {
			const route = routes.get(agent.key);
			if (!route) continue;
			setTimeout(
				() =>
					sendPacket(flow, back ? route.ret : route.launch, {
						label: back ? `${agent.label} ✓` : `→ ${agent.unnamed ? "new subagent" : agent.label}`,
						tone: back ? "good" : "accent",
					}),
				index * 140,
			);
		}
	}
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

// ---------------------------------------------------------------------------------------------
// The selected agent's tool calls, in a panel beside the tree. Its rows are kept from render to
// render, so a call opened to read its arguments stays open while the agent keeps working.

/** Strings as they are, anything else as indented JSON. */
function formatValue(value) {
	if (typeof value === "string") return value;
	try {
		return JSON.stringify(value, null, 2);
	} catch {
		return String(value);
	}
}

/** One line for a call: what its arguments say, else what its span says. */
function toolLine(tool) {
	if (tool.summary) return tool.summary;
	return tool.facts
		.filter(([label]) => label === "skill" || label === "resource" || label === "process")
		.map(([, value]) => value)
		.join(" · ");
}

function toolMark(tool) {
	if (tool.failed) return ["failed", "✕ failed"];
	const exit = tool.facts.find(([label]) => label === "exit code");
	if (exit && exit[1] !== "0") return ["warning", `! exit ${exit[1]}`];
	if (tool.permission && !/approved|allow/i.test(tool.permission)) return ["warning", `! ${tool.permission}`];
	return ["done", "✓"];
}

function selectAgent(key) {
	ui.agentKey = key;
	ui.link = null;
	scheduleRender(true);
}

function createToolRow() {
	const refs = {
		offset: el("span", { class: "tc-offset" }),
		name: el("span", { class: "tc-name" }),
		line: el("span", { class: "tc-line" }),
		tokens: el("span", { class: "tc-tokens" }),
		duration: el("span", { class: "tc-duration" }),
		mark: el("span", { class: "status" }),
		body: el("div", { class: "tc-body" }),
	};
	const row = el(
		"details",
		{ class: "tool-call" },
		el("summary", {}, refs.offset, refs.name, refs.line, refs.tokens, refs.duration, refs.mark),
		refs.body,
	);
	row._refs = refs;
	return row;
}

function updateToolRow(row, { tool, agent, view }) {
	const refs = row._refs;
	const launched = tool.launchedKey ? view.agents.get(tool.launchedKey) : null;
	const duration = formatDuration((tool.end ?? tool.start) - tool.start);
	// A `task` call names the agent it launched; its brief need not repeat the agent's name.
	let brief = toolLine(tool);
	if (launched && (brief === launched.name || brief.startsWith(`${launched.name} · `))) brief = brief.slice(launched.name.length + 3);
	const line = [launched ? `→ ${launched.label}` : null, brief].filter(Boolean).join(" · ");
	const [tone, mark] = toolMark(tool);
	refs.offset.textContent = Number.isFinite(agent.start) ? `+${formatDuration(tool.start - agent.start)}` : formatClock(tool.start);
	refs.offset.title = formatClock(tool.start);
	// An MCP call shows its server and the tool it called there.
	const nameSignature = tool.mcp ? `${mcpLabel(tool.mcp)}|${tool.mcp.tool}` : tool.name;
	if (refs.name.dataset.signature !== nameSignature) {
		refs.name.dataset.signature = nameSignature;
		refs.name.replaceChildren(...(tool.mcp ? [mcpBadge(tool.mcp), tool.mcp.tool] : [tool.name]));
		row.classList.toggle("mcp", Boolean(tool.mcp));
	}
	refs.tokens.textContent = tool.mcp && tool.cost ? `≈ ${formatTokens(tool.cost.tokens)}` : "";
	refs.tokens.title = tool.mcp && tool.cost ? "tokens its result added to the context: an estimate" : "";
	refs.line.textContent = line;
	refs.line.title = line;
	refs.duration.textContent = duration;
	refs.mark.className = `status ${tone}`;
	refs.mark.textContent = mark;

	// The details are rebuilt only when they change: an open row keeps its text selection.
	const cost = tool.cost ? [tool.cost.tokens, tool.cost.reads, tool.cost.credits].join(":") : "";
	const signature = [duration, tool.permission, tool.failed, tool.args != null, tool.result != null, launched?.label, launched?.status, cost, tool.mcp ? mcpLabel(tool.mcp) : ""].join("|");
	if (row._signature === signature) return;
	row._signature = signature;
	const facts = [
		["started", formatClock(tool.start)],
		["duration", duration],
		["call id", tool.callId],
		["permission", tool.permission],
		...(tool.mcp
			? [
					["mcp server", mcpLabel(tool.mcp)],
					["mcp tool", tool.mcp.tool],
					["server hash", tool.mcp.server ? null : tool.mcp.hash],
				]
			: []),
		["context", contextFact(tool)],
		...tool.facts,
	].filter(([, value]) => value != null && value !== "");
	const body = [
		el(
			"dl",
			{ class: "tc-facts" },
			facts.flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)]),
			launched
				? [
						el("dt", {}, "launched"),
						el(
							"dd",
							{},
							el("button", { type: "button", class: "link", onclick: () => selectAgent(launched.key) }, launched.label),
							` · ${launched.status}`,
						),
					]
				: null,
		),
	];
	if (tool.args != null) body.push(el("div", { class: "tc-label" }, "arguments"), el("pre", { class: "tc-pre" }, formatValue(tool.args)));
	if (tool.result != null) body.push(el("div", { class: "tc-label" }, "result"), el("pre", { class: "tc-pre" }, formatValue(tool.result)));
	if (tool.args == null && tool.result == null) body.push(el("div", { class: "tc-none" }, "arguments and result not captured"));
	refs.body.replaceChildren(...body);
}

/** What a call's result cost: the tokens it added to the context, the calls that read it, the credits. */
function contextFact(tool) {
	if (!tool.cost) return tool.end == null ? null : "not read by a later LLM call (yet)";
	const { tokens, reads, credits, shared } = tool.cost;
	return [
		`≈ ${formatTokens(tokens)} tokens`,
		`read by ${reads} LLM call${reads === 1 ? "" : "s"}`,
		credits != null ? `≈ ${formatCredits(credits)}` : null,
		shared ? "shared evenly with the calls of its round" : null,
	]
		.filter(Boolean)
		.join(" · ");
}

/** The agent's MCP use, server by server, and the servers it could call and did not. */
function renderToolsMcp(agent) {
	const block = $("tools-mcp");
	const unused = agent.mcpAvailable.filter((entry) => !agent.mcp.some((used) => used.key === (entry.server ?? entry.hash)));
	const signature = JSON.stringify([agent.mcp.map((entry) => [entry.key, entry.calls, entry.failed, entry.tokens, entry.credits, [...entry.tools]]), unused.map(mcpLabel)]);
	if (block.dataset.signature === signature) return;
	block.dataset.signature = signature;
	block.hidden = agent.mcp.length === 0 && unused.length === 0;
	const rows = agent.mcp.map((entry) =>
		el(
			"div",
			{ class: "mcp-row" },
			mcpBadge(entry),
			el("span", {}, `${entry.calls} call${entry.calls === 1 ? "" : "s"}${entry.failed ? ` · ${entry.failed} failed` : ""}`),
			el("span", { class: "mcp-tools", title: [...entry.tools.keys()].join(", ") }, [...entry.tools].map(([tool, count]) => (count > 1 ? `${tool} ×${count}` : tool)).join(", ")),
			el("span", { class: "mcp-cost", title: "Tokens their results added to the context, and what reading them cost: an estimate" }, entry.costed ? formatContext(entry.tokens, entry.credits) : "—"),
		),
	);
	block.replaceChildren(
		el("div", { class: "tc-label" }, "mcp"),
		...rows,
		unused.length ? el("div", { class: "muted mcp-unused" }, "available, not called: ", unused.flatMap((entry, index) => [index ? " " : null, mcpBadge(entry)])) : null,
	);
}

const toolsMemory = { scope: null };

function renderTools(view) {
	const panel = $("tools-panel");
	const agent = ui.agentKey ? view?.agents.get(ui.agentKey) : null;
	panel.hidden = !agent;
	if (!agent) {
		toolsMemory.scope = null;
		return;
	}
	const tools = [...agent.tools].sort((x, y) => x.start - y.start);
	const failed = tools.filter((tool) => tool.failed).length;
	$("tools-meta").textContent = `${tools.length} call${tools.length === 1 ? "" : "s"}${failed ? ` · ${failed} failed` : ""}`;

	// Rebuilt only when it changes: its buttons must outlive a click.
	const launched = Boolean(agent.parentKey && view.agents.has(agent.parentKey));
	const head = [agent.label, agent.status, formatDuration(agent.durationMs), agent.turn, agent.resumeOf, agent._launcher, launched].join("|");
	if ($("tools-agent").dataset.signature !== head) {
		$("tools-agent").dataset.signature = head;
		replace(
			"tools-agent",
			el("span", { class: "tools-agent-name" }, agent.label),
			el("span", { class: `status ${agent.status}` }, `${STATUS_MARK[agent.status] ?? "·"} ${agent.status}`),
			el("span", { class: "muted" }, formatDuration(agent.durationMs)),
			agent.root ? el("span", { class: "muted", title: turnTitle(agent) }, turnTag(agent)) : agent._launcher ? el("span", { class: "muted" }, `↳ ${agent._launcher}`) : null,
			// The messages on its lines, for whoever cannot point at a line.
			launched
				? el(
						"span",
						{ class: "tools-messages" },
						el("button", { type: "button", class: "link", onclick: () => selectLines("launch", [agent.key]) }, "message sent"),
						" · ",
						el("button", { type: "button", class: "link", onclick: () => selectLines("ret", [agent.key]) }, "sent back"),
					)
				: null,
		);
	}

	renderToolsMcp(agent);

	const counts = new Map();
	for (const tool of tools) counts.set(tool.name, (counts.get(tool.name) ?? 0) + 1);
	replace(
		"tools-tally",
		[...counts]
			.sort((x, y) => y[1] - x[1] || x[0].localeCompare(y[0]))
			.map(([name, count]) => el("span", { class: "badge" }, count > 1 ? `${name} ×${count}` : name)),
	);
	$("tools-tally").hidden = tools.length === 0;

	const list = $("tools-list");
	const scope = `${view.id}|${agent.key}`;
	const sameScope = toolsMemory.scope === scope;
	toolsMemory.scope = scope;
	const stick = list.scrollHeight - list.scrollTop - list.clientHeight < 40;
	const created = reconcile(
		list,
		tools.map((tool) => ({ tool, agent, view })),
		(item) => item.tool.span.spanId,
		createToolRow,
		updateToolRow,
	);
	list.hidden = tools.length === 0;
	if (!sameScope) list.scrollTop = 0;
	else if (stick) list.scrollTop = list.scrollHeight;
	if (sameScope && created.length <= 20) for (const row of created) flash(row, "entering");

	const note = agent.placeholder
		? "This agent reports its own calls when its turn ends."
		: tools.length === 0
			? "No tool call reported yet."
			: tools.some((tool) => tool.args != null || tool.result != null)
				? ""
				: "Arguments and results show here with chat.agentHost.otel.captureContent: true.";
	$("tools-note").textContent = note;
	$("tools-note").hidden = !note;
}

// ---------------------------------------------------------------------------------------------
// The messages a line carries: what a parent sent the agents it reaches, or what they sent back.
// A stretch that several agents' lines share carries all their messages.

const CAPTURE_HINT = "It shows with chat.agentHost.otel.captureContent: true, or with the hooks' tool events.";

function agentButton(agent) {
	return el("button", { type: "button", class: "link", title: `Show ${agent.label}'s tool calls`, onclick: () => selectAgent(agent.key) }, agent.label);
}

/** Who sends to whom along lines of one direction, and what a click on them shows. */
function describeLines(view, kind, keys) {
	const agents = keys.map((key) => view.agents.get(key)).filter(Boolean);
	const parent = agents[0] ? (kind === "ret" ? readerOf(view, agents[0]) : view.agents.get(agents[0].parentKey)) : null;
	if (!parent) return "";
	const names = agents.map((agent) => agent.label).join(", ");
	const many = agents.length > 1;
	return kind === "ret"
		? `${names} → ${parent.label}${parent.resumeOf ? ` (${turnTag(parent)})` : ""}\nclick to read ${many ? `the ${agents.length} answers` : "what it sent back"}`
		: `${parent.label} → ${names}\nclick to read ${many ? `the ${agents.length} messages sent` : "what it was sent"}`;
}

function selectLines(kind, keys) {
	const same = ui.link?.kind === kind && ui.link.keys.length === keys.length && keys.every((key) => ui.link.keys.includes(key));
	ui.link = same ? null : { kind, keys: [...keys] };
	ui.agentKey = null;
	ui.reveal = !same;
	scheduleRender(true);
}

/** One agent's message: when it went, then the description, the text, the other arguments. */
function messageItem({ agent, parent, message }, back, single) {
	const when = back
		? agent.done
			? `sent back after ${formatDuration(agent.durationMs)} of work`
			: agent.status
		: agent._offset
			? `sent ${agent._offset} into ${parent.label}'s run`
			: "";
	const head = el(
		"div",
		{ class: "message-head" },
		single ? null : el("span", { class: "message-who" }, agentButton(agent)),
		!single && message.at ? el("span", { class: "muted" }, formatClock(message.at)) : null,
		when ? el("span", { class: "muted" }, when) : null,
	);
	const body = [];
	if (!back && message.title) body.push(el("div", { class: "message-title" }, message.title));
	if (message.text) body.push(el("pre", { class: "message-text" }, message.text));
	if (!back && message.fields.length > 0) {
		body.push(el("dl", { class: "tc-facts" }, message.fields.flatMap(([label, value]) => [el("dt", {}, label), el("dd", {}, value)])));
	}
	let note = "";
	if (back && !agent.done) {
		note = agent.status === "failed" ? `${agent.label} failed.` : `${agent.label} is still working: its answer comes back when it finishes.`;
	} else if (!message.text) {
		const what = back ? "The answer was not reported." : message.title ? "Only the description was reported, not the prompt." : "The prompt was not reported.";
		note = `${what} ${CAPTURE_HINT}`;
		// The agent host exports the launching call with the root agent's spans, when its turn ends.
		if (!agent.launchTool && parent.placeholder) note += ` The call that launched ${agent.label} reports when ${parent.label}'s turn ends.`;
	}
	if (note) body.push(el("div", { class: "empty-note" }, note));
	return el("section", { class: "message-item" }, head.childNodes.length ? head : null, body);
}

const messageMemory = { signature: null };

function renderMessage(view) {
	const panel = $("message-panel");
	const agents = (ui.link?.keys ?? [])
		.map((key) => view?.agents.get(key))
		.filter((agent) => agent?.parentKey && view.agents.has(agent.parentKey))
		.sort((x, y) => x.start - y.start);
	panel.hidden = agents.length === 0;
	if (panel.hidden) {
		messageMemory.signature = null;
		return;
	}
	const back = ui.link.kind === "ret";
	for (const button of panel.querySelectorAll("[data-direction]")) {
		button.setAttribute("aria-pressed", String(button.dataset.direction === ui.link.kind));
	}
	const items = agents.map((agent) => {
		const { sent, returned } = handoffOf(agent);
		const parent = view.agents.get(agent.parentKey);
		// Whoever reads the answer: the launcher, or the run started to read it.
		return { agent, parent, target: back ? (readerOf(view, agent) ?? parent) : parent, message: back ? returned : sent };
	});
	const single = items.length === 1;
	$("message-meta").textContent = single
		? items[0].message.at
			? formatClock(items[0].message.at)
			: ""
		: `${items.length} ${back ? "answers" : "messages"}`;

	// Rebuilt only when it changes: a reader's text selection survives the live updates.
	const signature = [
		view.id,
		ui.link.kind,
		...items.map(({ agent, parent, target, message }) =>
			[agent.key, agent.label, agent.status, agent._offset, parent.label, target.key, message.title, message.text, Boolean(agent.launchTool)].join("\u0001"),
		),
	].join("\u0000");
	if (messageMemory.signature === signature) return;
	messageMemory.signature = signature;

	// The route: the launcher and every agent its line reaches, or those agents and the launcher.
	const launchers = [...new Set(items.map((item) => item.target))].flatMap((parent, index) => [index > 0 ? ", " : null, agentButton(parent)]);
	const reached = el("span", { class: "message-agents" }, items.flatMap(({ agent }, index) => [index > 0 ? ", " : null, agentButton(agent)]));
	const arrow = el("span", { class: "message-arrow", "aria-label": "to" }, "→");
	replace("message-route", back ? [reached, arrow, ...launchers] : [...launchers, arrow, reached]);
	replace("message-body", items.map((item) => messageItem(item, back, single)));
}

/** On a narrow screen the side panels lie below the tree: brings the one just opened into view. */
function revealPanel() {
	ui.reveal = false;
	const panel = [$("tools-panel"), $("message-panel")].find((candidate) => !candidate.hidden);
	if (!panel) return;
	const box = panel.getBoundingClientRect();
	if (box.top < 0 || box.top > window.innerHeight - 80) {
		panel.scrollIntoView({ block: "start", behavior: motionAllowed() ? "smooth" : "auto" });
	}
}

/** The progress panel keeps its bar and its list, so the bar slides and a step lights up. */
const progressParts = (() => {
	const parts = {
		headline: el("div"),
		fill: el("div", { class: "progress-fill" }),
		list: el("ul", { class: "todos" }),
		note: el("div", { class: "empty-note" }),
	};
	parts.track = el("div", { class: "progress-track" }, parts.fill);
	$("progress").replaceChildren(parts.headline, parts.track, parts.list, parts.note);
	return parts;
})();

const TODO_MARK = { completed: "[x]", "in-progress": "[>]", pending: "[ ]" };

function todoState(status) {
	return /complete|done/i.test(status) ? "completed" : /progress|active/i.test(status) ? "in-progress" : "pending";
}

function renderProgress(view) {
	const parts = progressParts;
	if (!view) {
		parts.headline.textContent = "—";
		parts.track.hidden = true;
		parts.list.replaceChildren();
		parts.note.textContent = "";
		return;
	}
	let done;
	let total;
	if (view.todos) {
		total = view.todos.length;
		done = view.todos.filter((todo) => todoState(todo.status) === "completed").length;
		parts.headline.textContent = `${done} of ${total} steps done`;
		reconcile(
			parts.list,
			view.todos,
			(todo) => todo.title,
			() => {
				const item = el("li", {}, el("span", { class: "todo-mark" }), el("span", { class: "todo-title" }));
				return item;
			},
			(item, todo) => {
				const state = todoState(todo.status);
				if (item._state && item._state !== state) flash(item, "step-changed");
				item._state = state;
				item.className = state;
				item.firstChild.textContent = TODO_MARK[state];
				item.lastChild.textContent = todo.title;
			},
		);
		parts.note.textContent = "";
	} else {
		total = view.subagents.length;
		done = view.subagents.filter((agent) => agent.status === "done").length;
		parts.headline.textContent = total ? `${done} of ${total} subagents done` : "no subagent started yet";
		parts.list.replaceChildren();
		parts.note.textContent = view.waitingForUser
			? "The agent handed the turn back: it waits for you."
			: "The agent's todo list shows here when hooks or OTel content capture report it.";
	}
	parts.track.hidden = total === 0;
	parts.fill.style.width = total ? `${(done / total) * 100}%` : "0%";
	parts.track.classList.toggle("active", view.live && done < total);
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

/** Horizontal bars, one per row, kept from render to render so a bar slides to its new length. */
function renderBars(container, rows, valueOf, labelOf, tipOf) {
	let list = container.querySelector(":scope > .bars");
	if (!list) {
		list = el("div", { class: "bars" });
		container.replaceChildren(list);
	}
	const max = Math.max(...rows.map(valueOf), 0);
	reconcile(
		list,
		rows,
		(row) => row.key ?? row.name,
		() =>
			el(
				"div",
				{ class: "bar-row" },
				el("span", { class: "bar-label" }),
				el("div", { class: "bar-track" }, el("div", { class: "bar-fill", style: { width: "0%" } })),
				el("span", { class: "bar-value" }),
			),
		(node, row) => {
			const [label, track, value] = node.children;
			node.dataset.tip = tipOf(row);
			label.textContent = row.name;
			label.title = row.name;
			value.textContent = labelOf(row);
			const width = max ? `${Math.max(2, (valueOf(row) / max) * 100)}%` : "0%";
			// Set after the first frame, so a new bar grows from zero.
			if (track.firstChild.style.width !== width) requestAnimationFrame(() => (track.firstChild.style.width = width));
		},
	);
}

function emptyNote(id, text = "—") {
	$(id).replaceChildren(el("div", { class: "empty-note" }, text));
}

function renderCosts(view) {
	if (!view || view.agents.size === 0) {
		emptyNote("cost-agents");
		emptyNote("cost-models");
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
		.map((row) => ({ ...row, key: row.name, name: row.runs > 1 ? `${row.name} ×${row.runs}` : row.name }))
		.sort((x, y) => y.credits - x.credits);
	$("cost-note").textContent = view.totals.estimated ? "estimated" : "AI credits";
	renderBars(
		$("cost-agents"),
		agentRows,
		(row) => row.credits,
		(row) => (row.pending && row.calls === 0 ? "pending" : formatCredits(row.credits)),
		(row) => `${row.name}\n${formatCredits(row.credits)} ≈ ${formatUsd(row.usd)}\n${formatTokens(row.input)} in · ${formatTokens(row.output)} out · ${row.calls} LLM calls`,
	);
	const modelRows = [...view.byModel]
		.map(([model, t]) => ({ name: shortModel(model), key: model, model, ...t }))
		.sort((x, y) => y.credits - x.credits);
	renderBars(
		$("cost-models"),
		modelRows,
		(row) => row.credits,
		(row) => `${formatCredits(row.credits)} · ${row.calls}×`,
		(row) => `${row.model}\n${row.calls} calls · ${formatCredits(row.credits)} ≈ ${formatUsd(row.usd)}\ncache ${formatPercent(row.cacheRead, row.input)} of ${formatTokens(row.input)} input`,
	);
}

// ---------------------------------------------------------------------------------------------
// Indicators: each against its target (public/indicators.js).

const JOURNAL_REFRESH_MS = 15_000;

/** The hooks' time of a session: asked of the server once, then every 15 s while it runs. */
function journalOf(view, now) {
	const entry = ui.journal.get(view.id);
	const stale = !entry || (view.live && now - entry.at > JOURNAL_REFRESH_MS);
	if (stale && !entry?.pending) {
		ui.journal.set(view.id, { at: now, hooks: entry?.hooks ?? null, pending: true });
		getJson(`/api/journal?session=${encodeURIComponent(view.id)}`)
			.then((body) => ui.journal.set(view.id, { at: Date.now(), hooks: body?.hooks ?? null, pending: false }))
			.catch(() => ui.journal.set(view.id, { at: Date.now(), hooks: entry?.hooks ?? null, pending: false }))
			.finally(() => scheduleRender());
	}
	return entry?.hooks ?? null;
}

const mark = (over, measured = true) => (!measured ? "" : over ? " over" : " ok");

function indicatorRow(label, value, target, className, tip) {
	return [
		el("span", { class: "indicator-label" }, label),
		el(
			"span",
			{ class: "indicator-cell" },
			el("span", { class: `indicator-value${className}`, tip }, value),
			el("span", { class: "indicator-target" }, target),
		),
	];
}

function renderIndicators(view, now) {
	if (!view || view.agents.size === 0) {
		emptyNote("indicators");
		return;
	}
	const hooks = journalOf(view, now);
	const k = sessionIndicators(view, hooks);
	const wake = k.wakeUps;
	replace(
		"indicators",
		el(
			"div",
			{ class: "indicators" },
			indicatorRow(
				"cost",
				`${formatCredits(k.credits)} ≈ ${formatUsd(view.totals.usd)}`,
				"per ticket",
				"",
				"What the session cost. Compare it ticket by ticket in the history.",
			),
			indicatorRow(
				"wake-ups",
				wake.count === 0 ? "none" : `${wake.count} × ${formatTokens(Math.round(wake.average))} · ${formatCredits(wake.credits)}`,
				`< ${formatTokens(TARGETS.wakeUpTokens)} each`,
				mark(wake.over, wake.count > 0),
				"Calls of the root agent that found its cache cold and wrote its whole context again: it had waited more than 5 minutes for its subagents or for you. /compact before a long wait makes each one smaller.",
			),
			indicatorRow(
				"largest context",
				k.context.max ? `${formatTokens(k.context.max)} · ${k.context.agent}` : "—",
				`< ${formatTokens(TARGETS.contextTokens)}`,
				mark(k.context.over, k.context.max > 0),
				k.context.runs.map((run) => `${run.label}: ${formatTokens(run.max)}`).join("\n") || "No LLM call yet.",
			),
			indicatorRow(
				"hooks",
				k.hooks ? `${Math.round(k.hooks.share * 100)}% · ${formatDuration(k.hooks.hookMs)}` : "—",
				`< ${Math.round(TARGETS.hookShare * 100)}% of agent time`,
				mark(k.hooks?.over, Boolean(k.hooks)),
				k.hooks
					? `Hooks took ${formatDuration(k.hooks.hookMs)} of the agents' ${formatDuration(k.hooks.workMs)} of work: each one is a process the agent waits for.`
					: "Read from Copilot's journal of the session (~/.copilot/session-state), which is not on this machine.",
			),
		),
	);
}

/** The session's MCP servers: who called each, how often, what the results cost; and the unused ones. */
function renderMcp(view) {
	const container = $("mcp");
	if (!view) {
		container.dataset.signature = "";
		emptyNote("mcp");
		$("mcp-meta").textContent = "";
		return;
	}
	const unused = view.mcpAvailable.filter((entry) => !view.mcp.some((used) => used.key === entry.key));
	const total = mcpTotals(view.mcp);
	$("mcp-meta").textContent = total.calls
		? `${total.calls} call${total.calls === 1 ? "" : "s"}${total.costed ? ` · ${formatContext(total.tokens, total.credits)}` : ""}`
		: "";
	// Rebuilt only when it changes: its buttons must outlive a click.
	const labels = (keys) => [...keys].map((key) => view.agents.get(key)?.label);
	const signature = JSON.stringify([
		view.id,
		view.mcp.map((entry) => [entry.key, entry.calls, entry.failed, entry.tokens, entry.credits, labels(entry.agents)]),
		unused.map((entry) => [entry.key, labels(entry.agents)]),
	]);
	if (container.dataset.signature === signature) return;
	container.dataset.signature = signature;
	const agentsOf = (keys) =>
		[...keys]
			.map((key) => view.agents.get(key))
			.filter(Boolean)
			.flatMap((agent, index) => [index ? ", " : null, agentButton(agent)]);
	const called = view.mcp.map((entry) =>
		el(
			"div",
			{ class: "mcp-server", tip: `${mcpLabel(entry)}\n${[...entry.tools].map(([tool, count]) => `${tool} ×${count}`).join("\n")}` },
			el(
				"div",
				{ class: "mcp-server-head" },
				mcpBadge(entry),
				el("span", {}, `${entry.calls} call${entry.calls === 1 ? "" : "s"}${entry.failed ? ` · ${entry.failed} failed` : ""}`),
				el("span", { class: "mcp-cost" }, entry.costed ? formatContext(entry.tokens, entry.credits) : "—"),
			),
			el("div", { class: "mcp-server-agents muted" }, "by ", agentsOf(entry.agents)),
		),
	);
	const idle = unused.map((entry) =>
		el(
			"div",
			{ class: "mcp-server idle" },
			el("div", { class: "mcp-server-head" }, mcpBadge(entry), el("span", { class: "muted" }, "not called")),
			el("div", { class: "mcp-server-agents muted" }, "available to ", agentsOf(entry.agents)),
		),
	);
	if (called.length === 0 && idle.length === 0) {
		emptyNote("mcp", "No MCP server reported in this session.");
		return;
	}
	container.replaceChildren(
		...called,
		...idle,
		total.costed
			? el(
					"div",
					{ class: "empty-note" },
					"Tokens: what the results added to each agent's context; credits: every later LLM call reading them. An estimate: tool spans carry no token count.",
				)
			: null,
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
		const label = agent.root ? `${agent.label} · ${turnTag(agent, true)}` : `└ ${agent.label}`;
		grid.append(
			el(
				"div",
				{
					class: `tl-label${selected ? " selected" : ""}`,
					title: label,
					onclick: () => {
						ui.agentKey = selected ? null : agent.key;
						ui.link = null;
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
				el("div", { class: `tl-tool${tool.mcp ? " mcp" : ""}`, style: { left: x(tool.start) } }),
				el("div", {
					class: "tl-hit",
					style: { left: x(tool.start) },
					tip: `${tool.mcp ? `mcp · ${mcpLabel(tool.mcp)} · ${tool.mcp.tool}` : `tool · ${tool.name}`}${tool.summary ? `\n${tool.summary}` : ""}\n${formatDuration((tool.end ?? tool.start) - tool.start)}${tool.permission ? ` · ${tool.permission}` : ""}${tool.failed ? " · failed" : ""}${tool.mcp && tool.cost ? `\n${formatContext(tool.cost.tokens, tool.cost.credits)}` : ""}`,
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

/** Every log entry, each with a key that stays the same from one render to the next. */
function logEntries(view, { filtered = true } = {}) {
	const entries = view.log.map((entry) => ({
		...entry,
		key:
			entry.type === "llm"
				? `llm:${entry.call.span.spanId}`
				: entry.type === "tool"
					? `tool:${entry.tool.span.spanId}`
					: `hook:${entry.time}:${entry.hook?.phase}:${entry.hook?.tool}`,
	}));
	for (const agent of view.agents.values()) {
		if (Number.isFinite(agent.start)) entries.push({ key: `start:${agent.key}`, time: agent.start, type: "agent-start", agentKey: agent.key, agent });
		if (agent.done && agent.end) entries.push({ key: `end:${agent.key}`, time: agent.end, type: "agent-end", agentKey: agent.key, agent });
	}
	entries.sort((x, y) => x.time - y.time);
	return filtered && ui.agentKey ? entries.filter((entry) => entry.agentKey === ui.agentKey) : entries;
}

function describeEntry(view, entry) {
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
		// An MCP call says so, with its server and what its result cost.
		kind = tool.mcp ? "mcp" : "tool";
		what = tool.mcp ? "mcp" : "tool";
		detail = [
			tool.mcp ? `${mcpLabel(tool.mcp)} · ${tool.mcp.tool}` : tool.name,
			tool.summary,
			tool.permission,
			tool.failed ? "failed" : null,
			formatDuration((tool.end ?? tool.start) - tool.start),
			tool.mcp && tool.cost ? formatContext(tool.cost.tokens, tool.cost.credits) : null,
		]
			.filter(Boolean)
			.join(" · ");
	} else if (entry.type === "agent-start") {
		kind = "agent";
		what = "start";
		detail = entry.agent.root ? turnTag(entry.agent) : `delegated${entry.agent.brief ? ` · ${entry.agent.brief}` : ""}`;
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
	return { who, what, detail, cost, kind };
}

function createLogRow() {
	return el(
		"div",
		{ class: "log-row" },
		el("span", { class: "when" }),
		el("span", { class: "who" }),
		el("span", { class: "what" }),
		el("span", { class: "detail" }),
		el("span", { class: "cost" }),
	);
}

const logMemory = { scope: null };

function renderLog(view) {
	const log = $("log");
	if (!view) {
		log.replaceChildren(el("div", { class: "empty-note" }, "—"));
		$("log-meta").textContent = "";
		logMemory.scope = null;
		return;
	}
	const stick = log.scrollHeight - log.scrollTop - log.clientHeight < 40;
	const entries = logEntries(view);
	const shown = entries.slice(-500);
	const agent = ui.agentKey ? view.agents.get(ui.agentKey) : null;
	$("log-meta").textContent = `${agent ? `${agent.label} only · ` : ""}${entries.length} event${entries.length === 1 ? "" : "s"}${entries.length > shown.length ? ` · last ${shown.length}` : ""}`;
	// A new session or a new filter fills the log at once: no row slides in then.
	const scope = `${view.id}|${ui.agentKey ?? ""}`;
	const sameScope = logMemory.scope === scope;
	logMemory.scope = scope;
	const created = reconcile(log, shown, (entry) => entry.key, createLogRow, (row, entry) => {
		const { who, what, detail, cost, kind } = describeEntry(view, entry);
		const [when, whoCell, whatCell, detailCell, costCell] = row.children;
		when.textContent = formatClock(entry.time);
		whoCell.textContent = who;
		whoCell.title = who;
		whatCell.className = `what ${kind}`;
		whatCell.textContent = what;
		detailCell.textContent = detail;
		detailCell.title = detail;
		costCell.textContent = cost;
	});
	if (sameScope && created.length <= 20) for (const row of created) flash(row, "entering");
	if (stick) log.scrollTop = log.scrollHeight;
}

/** The status line keeps its prompt and cursor; the latest event is typed in after the prompt. */
const statusParts = (() => {
	const parts = {
		typed: el("span", { class: "typed" }),
		cursor: el("span", { class: "cursor", "aria-hidden": "true" }, "▌"),
		agents: el("span", { class: "agents" }),
		cost: el("span", { class: "cost-total" }),
	};
	$("statusline").replaceChildren(
		el("span", { class: "prompt" }, "~/agents $"),
		el("span", { class: "command" }, parts.typed, parts.cursor),
		parts.agents,
		parts.cost,
	);
	return parts;
})();

function renderStatusline(view) {
	const parts = statusParts;
	if (!view) {
		typeInto(parts.typed, "waiting for agents");
		parts.agents.textContent = "";
		parts.cost.textContent = "";
		return;
	}
	const latest = logEntries(view, { filtered: false }).at(-1);
	if (latest && latest.key !== parts.typed.dataset.key) {
		parts.typed.dataset.key = latest.key;
		const { who, what, detail } = describeEntry(view, latest);
		typeInto(parts.typed, `${who} ${what} ${detail}`.slice(0, 110));
	}
	const agents = [...view.agents.values()].sort((x, y) => x.start - y.start).slice(-8);
	parts.agents.textContent = agents.map((agent) => `${agent.label} [${agent.status}]`).join("  ");
	parts.cost.textContent = `cost [${formatCredits(view.totals.credits)}]`;
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

	renderBars(
		$("history-ticket-bars"),
		[...tickets].sort((x, y) => y.credits - x.credits).slice(0, 12).map((entry) => ({ ...entry, name: entry.ticket })),
		(row) => row.credits,
		(row) => formatCredits(row.credits),
		(row) => `${row.ticket}\n${row.sessions} session(s) · ${formatCredits(row.credits)} ≈ ${formatUsd(row.usd)}`,
	);

	const agentTotals = new Map();
	for (const summary of summaries) {
		for (const [name, agent] of Object.entries(summary.byAgent ?? {})) {
			agentTotals.set(name, (agentTotals.get(name) ?? 0) + agent.credits);
		}
	}
	renderBars(
		$("history-agent-bars"),
		[...agentTotals].map(([name, credits]) => ({ name, credits })).sort((x, y) => y.credits - x.credits),
		(row) => row.credits,
		(row) => `${formatCredits(row.credits)} · ${formatPercent(row.credits, total)}`,
		(row) => `${row.name}\n${formatCredits(row.credits)} over the period`,
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
			[
				["started"],
				["ticket"],
				["workspace"],
				["root agent"],
				["agents", true],
				["wall clock", true],
				["tokens in", true],
				["cost", true],
				["wake-ups", true],
				["max context", true],
				["hooks", true],
				[""],
			],
			listed.map((summary) => {
				const loaded = store.sessions.has(summary.id);
				// Summaries written before the indicators existed have none.
				const k = summary.indicators;
				const wake = k?.wakeUps;
				const hooks = k?.hooks;
				const rated = (over, measured = true) => (measured ? (over ? "num over" : "num ok") : "num");
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
						{
							class: rated(wake?.average > TARGETS.wakeUpTokens, wake?.count > 0),
							title: wake?.count ? `${formatCredits(wake.credits)} on calls that rewrote a cold cache` : null,
						},
						!wake ? "—" : wake.count === 0 ? "0" : `${wake.count} × ${formatTokens(wake.average)}`,
					),
					el(
						"td",
						{ class: rated(k?.context.max > TARGETS.contextTokens, Boolean(k?.context.max)), title: k?.context.agent ?? null },
						k?.context.max ? formatTokens(k.context.max) : "—",
					),
					el(
						"td",
						{
							class: rated(hooks?.share > TARGETS.hookShare, Boolean(hooks)),
							title: hooks ? `${formatDuration(hooks.hookMs)} of ${formatDuration(hooks.workMs)} of agent work` : null,
						},
						hooks ? `${Math.round(hooks.share * 100)}%` : "—",
					),
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
		.filter((view) => !view.background && (view.agents.size > 0 || view.log.length > 0))
		.sort((x, y) => y.lastActivityAt - x.lastActivityAt);
}

// How long a session that has not handed the turn back keeps the page without a sign of activity.
const AT_WORK_MS = 120_000;

/**
 * The session to follow: the one shown, as long as it is at work; once it is done, the latest.
 * Another session's activity does not take the page from a session still running.
 */
function sessionToFollow(views, now) {
	const current = views.find((view) => view.id === ui.sessionId);
	const atWork = current && (current.live || (!current.waitingForUser && now - current.lastActivityAt < AT_WORK_MS));
	return atWork ? current.id : (views[0]?.id ?? null);
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
		ui.sessionId = sessionToFollow(views, now);
	}
	renderSessionPicker(views);
	const view = views.find((candidate) => candidate.id === ui.sessionId) ?? null;
	ui.session = view;
	if (ui.agentKey && !view?.agents.has(ui.agentKey)) ui.agentKey = null;
	if (ui.link) {
		const keys = ui.link.keys.filter((key) => view?.agents.has(key));
		ui.link = keys.length > 0 ? { kind: ui.link.kind, keys } : null;
	}
	ui.place = view ? placeOf(view, ui.workspaces) : null;
	ui.routing = view ? routingFor(view, definitionsOf(ui.place?.workspace)) : [];
	renderLive(view, now);
	renderKpis(view);
	renderFlow(view);
	renderTools(view);
	renderMessage(view);
	if (ui.reveal) revealPanel();
	renderIndicators(view, now);
	renderProgress(view);
	renderRouting(view);
	renderCosts(view);
	renderMcp(view);
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
	ui.link = null;
	$("follow").checked = false;
	scheduleRender(true);
});

$("follow").addEventListener("change", (event) => {
	ui.follow = event.target.checked;
	scheduleRender(true);
});

/** Closes the side panel open, and gives the focus back to the card or the line it belongs to. */
function closePanel() {
	let origin = null;
	if (ui.link) {
		origin = flow.querySelector(`.hit[data-key="${CSS.escape(ui.link.keys[0])}"][data-kind="${ui.link.kind}"]`);
		ui.link = null;
	} else if (ui.agentKey) {
		origin = flow.querySelector(`.card[data-key="${CSS.escape(ui.agentKey)}"]`);
		ui.agentKey = null;
	}
	scheduleRender(true);
	origin?.focus({ preventScroll: true });
}

$("tools-close").addEventListener("click", closePanel);
$("message-close").addEventListener("click", closePanel);
document.addEventListener("keydown", (event) => {
	if (event.key === "Escape" && ui.view === "live" && (ui.agentKey || ui.link)) closePanel();
});

// A line clicked shows its messages: on a stretch that several agents' lines share, all of theirs.
const hitAt = (event) => (event.target instanceof Element ? event.target.closest(".hit") : null);
const linesUnder = (event, hit) => linkLayer.linesAt(event.clientX, event.clientY) ?? { kind: hit.dataset.kind, keys: [hit.dataset.key] };

flow.addEventListener("click", (event) => {
	const hit = hitAt(event);
	if (!hit) return;
	const { kind, keys } = linesUnder(event, hit);
	selectLines(kind, keys);
});
flow.addEventListener("mousemove", (event) => {
	const hit = hitAt(event);
	if (!hit) {
		linkLayer.hover(null);
		return;
	}
	const lines = linesUnder(event, hit);
	linkLayer.hover(lines);
	// Read by the tooltip, which listens further up.
	if (ui.session) hit.dataset.tip = describeLines(ui.session, lines.kind, lines.keys);
});
flow.addEventListener("mouseleave", () => linkLayer.hover(null));
// From the keyboard, a line is one agent's: Tab reaches each in turn.
flow.addEventListener("keydown", (event) => {
	const hit = hitAt(event);
	if (hit && (event.key === "Enter" || event.key === " ")) {
		event.preventDefault();
		selectLines(hit.dataset.kind, [hit.dataset.key]);
	}
});
for (const button of document.querySelectorAll("#message-panel [data-direction]")) {
	button.addEventListener("click", () => {
		if (!ui.link) return;
		ui.link = { kind: button.dataset.direction, keys: ui.link.keys };
		scheduleRender(true);
	});
}

// The tool calls stay in view below the top bar, whose height changes as it wraps.
new ResizeObserver(([entry]) => {
	document.documentElement.style.setProperty("--topbar", `${Math.ceil(entry.target.getBoundingClientRect().height)}px`);
}).observe(document.querySelector(".topbar"));

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

async function refreshMcpNames() {
	try {
		const names = await getJson("/api/mcp");
		if (JSON.stringify(names) === JSON.stringify(ui.mcpNames)) return;
		ui.mcpNames = names;
		// Every session is derived again, its servers named.
		summaries.clear();
		scheduleRender();
	} catch {
		// Kept from the last refresh: servers show by their hash meanwhile.
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
	await Promise.all([refreshStatus(), refreshWorkspaces(), refreshMcpNames()]);
	setInterval(refreshWorkspaces, 30_000);
	setInterval(refreshMcpNames, 30_000);
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
