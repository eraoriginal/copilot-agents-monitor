import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { pathToFileURL } from "node:url";
import { createStore, deriveSession, ingest } from "../public/model.js";
import { counterfactual, normalizeModel, parseAgentFile, routingFor } from "../public/routing.js";
import { branchAt, matchWorkspace, placeOf, ticketOf } from "../public/workspaces.js";
import { currentBranch, discoverFolders, readAgents } from "../src/workspaces.js";

const CONDUCTOR = `---
name: conductor
description: Takes a Jira ticket or a prompt to a proposed commit.
argument-hint: A Jira key and one sentence, or a prompt
model: ['Claude Opus 5.5 (copilot)', 'Claude Opus 5 (copilot)']
reasoning-effort: high
tools: ['agent', 'read', 'search', 'edit', 'execute', 'todo']
agents: ['scout', 'implementer']
handoffs:
  - label: Review again
    agent: conductor
    send: false
hooks:
  Stop:
    - type: command
      command: node scripts/verify.mjs --stop-hook
---

# Conductor
`;

test("an agent file's front matter gives its name, models and subagents, nested maps skipped", () => {
	const agent = parseAgentFile(CONDUCTOR, "conductor.agent.md");
	assert.equal(agent.name, "conductor");
	assert.deepEqual(agent.modelLabels, ["Claude Opus 5.5 (copilot)", "Claude Opus 5 (copilot)"]);
	assert.deepEqual(agent.models, ["claude-opus-5-5", "claude-opus-5"]);
	assert.deepEqual(agent.agents, ["scout", "implementer"]);
});

test("an agent file without a model or a name falls back to its file name and no model", () => {
	const agent = parseAgentFile("---\ndescription: Finds things.\ntools: ['read']\n---\n", "finder.agent.md");
	assert.equal(agent.name, "finder");
	assert.deepEqual(agent.models, []);
});

test("model names from an agent file and from a span normalize alike", () => {
	assert.equal(normalizeModel("Claude Sonnet 5.5 (copilot)"), normalizeModel("claude-sonnet-5.5"));
	assert.equal(normalizeModel("GPT-6 Luna (copilot)"), "gpt-6-luna");
	assert.equal(normalizeModel(""), null);
});

const T0 = 1_792_273_390_000;
let n = 0;
function span(name, parent, s, e, attributes = {}, spanId = `x${++n}`) {
	return { traceId: "t", spanId, parentSpanId: parent, name, start: T0 + s * 1000, end: T0 + e * 1000, attributes: { "gen_ai.conversation.id": "c", ...attributes }, status: { code: 0 } };
}
function chat(parent, model, credits, initiator, tokens = { input: 10_000, output: 500 }) {
	return span(`chat ${model}`, parent, 1, 2, {
		"gen_ai.operation.name": "chat",
		"gen_ai.response.model": model,
		"gen_ai.usage.input_tokens": tokens.input,
		"gen_ai.usage.output_tokens": tokens.output,
		"github.copilot.nano_aiu": credits * 1e9,
		"github.copilot.initiator": initiator,
	});
}
function agentSpan(name, parent, spanId) {
	return span(`invoke_agent ${name}`, parent, 0, 3, { "gen_ai.operation.name": "invoke_agent", "gen_ai.agent.name": name }, spanId);
}
function viewOf(spans) {
	const store = createStore();
	for (const record of spans) ingest(store, { kind: "span", time: record.end, data: record });
	return deriveSession(store.sessions.get("c"), { now: T0 + 10_000 });
}

function team() {
	const taskA = span("execute_tool task", "root", 0.5, 3, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "task", "gen_ai.agent.name": "conductor" });
	const taskB = span("execute_tool task", "root", 0.5, 3, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "task", "gen_ai.agent.name": "conductor" });
	const taskC = span("execute_tool task", "root", 0.5, 3, { "gen_ai.operation.name": "execute_tool", "gen_ai.tool.name": "task", "gen_ai.agent.name": "conductor" });
	return viewOf([
		agentSpan("conductor", null, "root"),
		chat("root", "claude-opus-5.5", 3, "user"),
		taskA,
		agentSpan("scout", taskA.spanId, "scout"),
		chat("scout", "claude-haiku-5.5", 0.1, "sub-agent"),
		taskB,
		agentSpan("implementer", taskB.spanId, "impl"),
		chat("impl", "claude-sonnet-5", 1, "sub-agent"),
		taskC,
		agentSpan("reviewer", taskC.spanId, "rev"),
		chat("rev", "gpt-6-luna", 0.2, "sub-agent"),
	]);
}

const DEFINITIONS = new Map(
	[
		["conductor", ["Claude Opus 5.5 (copilot)", "Claude Opus 5 (copilot)"]],
		["scout", ["Claude Haiku 5.5 (copilot)"]],
		["implementer", ["Claude Sonnet 5.5 (copilot)", "Claude Sonnet 5 (copilot)"]],
		["reviewer", ["Claude Sonnet 5.5 (copilot)"]],
	].map(([name, models]) => [name, parseAgentFile(`---\nname: ${name}\nmodel: [${models.map((m) => `'${m}'`).join(", ")}]\n---\n`)]),
);

test("routing tells an agent on its model from one on a fallback or off its list", () => {
	const rows = Object.fromEntries(routingFor(team(), DEFINITIONS).map((row) => [row.name, row.status]));
	assert.deepEqual(rows, {
		conductor: "as-declared",
		scout: "as-declared",
		implementer: "fallback",
		reviewer: "off-list",
	});
	const unknown = routingFor(team(), new Map());
	assert.equal(unknown.every((row) => row.status === "unknown"), true);
});

test("the counterfactual prices every call at the root agent's model", () => {
	const pricing = { usdPerCredit: 0.01, models: { "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } } };
	const result = counterfactual(team(), pricing);
	assert.equal(result.baseline, "claude-opus-5.5");
	assert.ok(Math.abs(result.actual - 4.3) < 1e-9);
	// Root call as billed (3 cr), three subagent calls at Opus list price: 10k in × $4 + 500 out × $20 = $0.05 = 5 cr each.
	assert.ok(Math.abs(result.alternative - 18) < 1e-9);
	assert.equal(result.estimatedRate, false);
	assert.ok(result.saving > 0.7 && result.saving < 0.8);
});

test("without a list price for the root model, the counterfactual uses the rate it was billed at", () => {
	const result = counterfactual(team(), { usdPerCredit: 0.01, models: {} });
	assert.equal(result.estimatedRate, true);
	// Every call has the same token counts as the root call, so each costs what the root call did.
	assert.ok(Math.abs(result.alternative - 12) < 1e-9);
});

test("a ticket key is read from the branch name", () => {
	assert.equal(ticketOf("feat/FRCLM-46-edit-configuration-version"), "FRCLM-46");
	assert.equal(ticketOf("main"), null);
	assert.equal(ticketOf(null), null);
});

test("a session matches the workspace that defines all its agents, or the one a hook named", () => {
	const view = team();
	const workspaces = [
		{ path: "C:/a", name: "a", agents: [{ name: "conductor" }], branchHistory: [] },
		{ path: "C:/b", name: "b", agents: [...DEFINITIONS.values()], branchHistory: [{ since: T0 - 1000, branch: "feat/FRCLM-58-x" }] },
	];
	assert.equal(matchWorkspace(view, workspaces).name, "b");
	assert.equal(matchWorkspace({ ...view, cwd: "c:\\a\\src" }, workspaces).name, "a");
	assert.deepEqual(
		{ ...placeOf(view, workspaces), workspace: undefined },
		{ workspace: undefined, workspaceName: "b", workspacePath: "C:/b", branch: "feat/FRCLM-58-x", ticket: "FRCLM-58" },
	);
});

test("the branch at a time is the last change before it", () => {
	const workspace = { branchHistory: [{ since: 100, branch: "main" }, { since: 200, branch: "feat/FRCLM-1-x" }] };
	assert.equal(branchAt(workspace, 150), "main");
	assert.equal(branchAt(workspace, 250), "feat/FRCLM-1-x");
	assert.equal(branchAt(workspace, 50), "main");
});

test("folders, agents and branches are read from disk, worktrees included", (t) => {
	const root = mkdtempSync(join(tmpdir(), "agent-monitor-ws-"));
	t.after(() => rmSync(root, { recursive: true, force: true }));
	const repo = join(root, "repo");
	mkdirSync(join(repo, ".git"), { recursive: true });
	writeFileSync(join(repo, ".git", "HEAD"), "ref: refs/heads/feat/FRCLM-9-thing\n");
	mkdirSync(join(repo, ".github", "agents"), { recursive: true });
	writeFileSync(join(repo, ".github", "agents", "conductor.agent.md"), CONDUCTOR);
	const worktree = join(root, "worktree");
	mkdirSync(join(root, "gitdirs", "wt"), { recursive: true });
	writeFileSync(join(root, "gitdirs", "wt", "HEAD"), "ref: refs/heads/fix/other\n");
	mkdirSync(worktree);
	writeFileSync(join(worktree, ".git"), `gitdir: ${join(root, "gitdirs", "wt")}\n`);
	const storage = join(root, "workspaceStorage");
	mkdirSync(join(storage, "abc"), { recursive: true });
	writeFileSync(join(storage, "abc", "workspace.json"), JSON.stringify({ folder: pathToFileURL(repo).href }));

	assert.equal(currentBranch(join(repo, "src")), "feat/FRCLM-9-thing");
	assert.equal(currentBranch(worktree), "fix/other");
	assert.deepEqual(readAgents(repo).map((agent) => agent.name), ["conductor"]);
	assert.deepEqual(discoverFolders([storage]), [repo]);
});
