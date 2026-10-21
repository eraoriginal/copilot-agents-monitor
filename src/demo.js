/**
 * `--demo`: a conductor run replayed live, with spans shaped like those Copilot's agent host
 * exports. It runs the team of a conductor-and-specialists setup — three scouts in parallel,
 * designers, an implementer, two reviewers — on Haiku, Sonnet and Opus, over about two minutes.
 *
 * Each span is published a second or two after it ends, as the OTLP batch exporter would. The
 * todo list, the prompts the conductor sends and the answers it gets back carry tool arguments
 * and results, which a real run reports only with content capture on, or the hooks' tool events.
 */

import { createHash, randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { parseAgentFile } from "../public/routing.js";

const PRICES = JSON.parse(readFileSync(new URL("./pricing.json", import.meta.url), "utf8")).models;
const MODELS = {
	opus: { name: "claude-opus-5.5", price: PRICES["claude-opus-5-5"] },
	sonnet: { name: "claude-sonnet-5.5", price: PRICES["claude-sonnet-5-5"] },
	// The implementer's fallback: the run shows what the routing check reports for it.
	sonnet5: { name: "claude-sonnet-5", price: PRICES["claude-sonnet-5"] },
	haiku: { name: "claude-haiku-5.5", price: PRICES["claude-haiku-5-5"] },
};

const OPUS = ["Claude Opus 5.5 (copilot)", "Claude Opus 5 (copilot)"];
const SONNET = ["Claude Sonnet 5.5 (copilot)", "Claude Sonnet 5 (copilot)"];
const HAIKU = ["Claude Haiku 5.5 (copilot)", "Claude Haiku 4.5 (copilot)"];
const TEAM = {
	conductor: OPUS,
	scout: HAIKU,
	"contract-keeper": SONNET,
	"ux-designer": OPUS,
	"ui-designer": SONNET,
	implementer: SONNET,
	"standards-reviewer": SONNET,
	"spec-reviewer": OPUS,
};
const DEMO_PATH = "C:/demo/mk-consumption-estimation-dashboard-admin";
const DEMO_BRANCH = "feat/FRCLM-58-archive-variable";

/** The workspace the demo's agents come from: a conductor and seven specialists. */
export function demoWorkspace(now) {
	return {
		path: DEMO_PATH,
		name: "mk-consumption-estimation-dashboard-admin",
		agents: Object.entries(TEAM).map(([name, models]) =>
			parseAgentFile(`---\nname: ${name}\nmodel: [${models.map((model) => `'${model}'`).join(", ")}]\n---\n`, `${name}.agent.md`),
		),
		branch: DEMO_BRANCH,
		branchHistory: [{ since: now - 6 * 3_600_000, branch: DEMO_BRANCH }],
	};
}

/** Past sessions for the history: a few tickets over the last days, and one off any ticket. */
export function demoPastSessions(now) {
	const plan = [
		["FRCLM-52", "feat/FRCLM-52-variable-catalogue", 5.2, 38],
		["FRCLM-52", "feat/FRCLM-52-variable-catalogue", 4.9, 21],
		["FRCLM-53", "feat/FRCLM-53-create-variable", 4.1, 55],
		["FRCLM-53", "feat/FRCLM-53-create-variable", 3.8, 17],
		["FRCLM-53", "feat/FRCLM-53-create-variable", 3.7, 12],
		["FRCLM-55", "feat/FRCLM-55-rename-variable", 2.6, 29],
		[null, "main", 2.1, 9],
		["FRCLM-56", "feat/FRCLM-56-variable-filters", 1.4, 44],
		["FRCLM-56", "feat/FRCLM-56-variable-filters", 1.2, 26],
		["FRCLM-58", DEMO_BRANCH, 0.12, 33],
	];
	const shares = {
		conductor: 0.38,
		implementer: 0.2,
		"ux-designer": 0.14,
		"spec-reviewer": 0.1,
		"standards-reviewer": 0.06,
		"ui-designer": 0.05,
		"contract-keeper": 0.04,
		scout: 0.03,
	};
	return plan.map(([ticket, branch, daysAgo, credits], index) => {
		const startedAt = Math.round(now - daysAgo * 86_400_000);
		const wallMs = Math.round(credits * 55_000);
		const byAgent = Object.fromEntries(
			Object.entries(shares).map(([name, share]) => [
				name,
				{ runs: name === "scout" ? 3 : 1, credits: credits * share, calls: Math.round(credits * share * 2) + 1, input: 0, output: 0 },
			]),
		);
		return {
			id: `demo-past-${index}`,
			title: "conductor",
			prompt: ticket ? `${ticket}` : "fix the flaky timeline test",
			startedAt,
			lastActivityAt: startedAt + wallMs,
			wallMs,
			turns: 1 + (index % 3),
			agents: 10,
			subagents: 9,
			workspace: DEMO_PATH,
			workspaceName: "mk-consumption-estimation-dashboard-admin",
			branch,
			branchGuessed: false,
			ticket,
			totals: {
				credits,
				usd: credits * 0.01,
				input: Math.round(credits * 7800),
				output: Math.round(credits * 420),
				cacheRead: Math.round(credits * 5200),
				calls: Math.round(credits * 0.9),
				tools: Math.round(credits * 0.85),
				estimated: false,
				unpriced: 0,
			},
			baseline: { model: "claude-opus-5.5", credits: credits * (1.7 + (index % 4) * 0.15) },
			byAgent,
			byModel: {
				"claude-opus-5.5": { calls: Math.round(credits * 0.3), credits: credits * 0.62 },
				"claude-sonnet-5.5": { calls: Math.round(credits * 0.45), credits: credits * 0.35 },
				"claude-haiku-5.5": { calls: Math.round(credits * 0.15), credits: credits * 0.03 },
			},
		};
	});
}

const STEPS = ["Intake", "Grill", "Specify", "Design", "Build", "Review", "Close"];

/** What the conductor sends each subagent, by brief, and what the subagent sends back. */
const HANDOFFS = {
	"the ticket FRCLM-58 and the Confluence pages it cites": {
		prompt: [
			"Read Jira ticket FRCLM-58 and the Confluence pages it links.",
			"Report, in under 15 lines:",
			"- the user story and its acceptance criteria",
			"- the business rules for archiving a variable: who, when, what happens to its versions",
			"- the questions the ticket leaves open",
			"Do not propose a design. Read only.",
		].join("\n"),
		reply: [
			"FRCLM-58 · Archive a variable",
			"",
			"Story: as an admin, I archive a variable nobody uses any more, so that it leaves the catalogue without losing its history.",
			"",
			"Acceptance criteria:",
			"1. An Archive action on each row of the variables screen, admins only.",
			"2. A confirmation dialog names the variable and its draft versions.",
			"3. Archiving a variable a published estimation uses is refused, and the estimation is named.",
			"4. An archived variable leaves the list; a filter shows the archived ones.",
			"",
			"Rules (Confluence FRCLM/Variables): archiving can be undone for 30 days; draft versions are archived with the variable.",
			"",
			"Open: the ticket does not say whether archived variables count toward the catalogue quota.",
		].join("\n"),
	},
	"the code under src/features/variables": {
		prompt: [
			"Map the code under src/features/variables.",
			"Report the components of the variables screen, where row actions are declared, how a mutation calls the API and refreshes the list, and the tests beside them.",
			"File paths and line numbers, no opinions. Read only.",
		].join("\n"),
		reply: [
			"src/features/variables",
			"- VariablesPage.tsx: table and filters; rows come from VariableRow.tsx",
			"- VariableRow.tsx:41-77: row actions (edit, duplicate) in a <RowMenu>, gated by useCan('variables:write')",
			"- api.ts: useUpdateVariable, useDuplicateVariable, react-query mutations; onSuccess invalidates ['variables']",
			"- VariableForm.tsx: create and edit form, zod schema in schema.ts",
			"- Tests: *.test.tsx beside each file, vitest and testing-library; MSW handlers in src/mocks/variables.ts",
			"",
			"No archive code yet, and no archived field in the list query.",
		].join("\n"),
	},
	"the endpoints the ticket needs in src/api/schema.ts": {
		prompt: [
			"Check src/api/schema.ts for the endpoints FRCLM-58 needs: archiving a variable, listing archived ones, and the error when a published estimation uses it.",
			"Quote the operation ids, request and response types. Say plainly what is missing. Read only.",
		].join("\n"),
		reply: [
			"src/api/schema.ts (generated from OpenAPI 3.1)",
			"- POST /variables/{id}/archive: archiveVariable, 204; 409 ConflictError { code: 'VARIABLE_IN_USE', estimationIds: string[] }",
			"- GET /variables?status=archived: status is 'active' | 'archived', 'active' by default",
			"- POST /variables/{id}/restore: missing.",
			"",
			"The schema is 9 days old and the backend changelog mentions restore since. Refresh the contract before building.",
		].join("\n"),
	},
	"the archive action on the variables screen": {
		prompt: [
			"Design the archive action on the variables screen for FRCLM-58.",
			"Inputs: .scratch/frclm-58/spec.md, docs/agents/design-system.md.",
			"Cover where the action sits, the confirmation dialog (copy in French and English), the refusal when a published estimation uses the variable, and the archived filter.",
			"Write .scratch/frclm-58/ux.md. No code.",
		].join("\n"),
		reply: [
			"Wrote .scratch/frclm-58/ux.md.",
			"- Action: last item of the row menu, « Archiver » / Archive, danger tone, admins only.",
			"- Dialog: the title names the variable, the body lists its draft versions, the main button reads « Archiver la variable ».",
			"- Refusal (409 VARIABLE_IN_USE): an inline error in the dialog, linking the estimations that use it. No toast.",
			"- Filter: a Statut select beside the search, Actives by default.",
			"",
			"For you: restore is out of scope, but the copy says archiving can be undone for 30 days.",
		].join("\n"),
	},
	"refresh the contract for POST /variables/{id}/archive": {
		prompt: [
			"Refresh the API contract for POST /variables/{id}/archive and GET /variables?status=archived.",
			"Run pnpm api:refresh, then report what changed in src/api/schema.ts that FRCLM-58 depends on.",
			"Never edit generated files by hand.",
		].join("\n"),
		reply: [
			"Ran pnpm api:refresh: schema.ts regenerated from backend 2.41.0.",
			"For FRCLM-58:",
			"- POST /variables/{id}/archive: unchanged (204, 409 VARIABLE_IN_USE).",
			"- New: POST /variables/{id}/restore (204), restoreVariable.",
			"- Variable gains archivedAt: string | null.",
			"Nothing else the ticket touches moved. Typecheck passes.",
		].join("\n"),
	},
	"plan mode: the components of the archive dialog": {
		prompt: [
			"Plan mode. From .scratch/frclm-58/ux.md, list the components of the archive dialog and of the filter:",
			"which design-system components to reuse, with which props, and any new one needed.",
			"Write .scratch/frclm-58/components.md. No code.",
		].join("\n"),
		reply: [
			"Wrote .scratch/frclm-58/components.md.",
			"- ArchiveVariableDialog (new): the design system's ConfirmDialog, tone=\"danger\", DraftVersionList inside.",
			"- DraftVersionList (new, small): a List of version names, hidden when empty.",
			"- In-use error: InlineAlert tone=\"critical\" with EstimationLink items.",
			"- Status filter: the existing Select, options from a STATUS_OPTIONS constant.",
			"No new design-system component needed.",
		].join("\n"),
	},
	"slice 1: archive a draft version's variable": {
		prompt: [
			"Slice 1 of FRCLM-58: archive a variable from a draft version.",
			"Follow .scratch/frclm-58/components.md.",
			"Test first: ArchiveVariable.test.tsx covers the menu item for admins, the dialog, the 204 path and the 409 VARIABLE_IN_USE path.",
			"Then build it, add the French and English strings, and run vitest and the typecheck.",
			"Report what you changed and the results.",
		].join("\n"),
		reply: [
			"Slice 1 done.",
			"Changed:",
			"- src/features/variables/ArchiveVariable.test.tsx (new): 6 tests",
			"- src/features/variables/VariableRow.tsx: Archive item in the row menu, gated by useCan('variables:archive')",
			"- src/features/variables/ArchiveVariableDialog.tsx (new)",
			"- src/features/variables/api.ts: useArchiveVariable, invalidates ['variables']",
			"- src/locales/{fr,en}/common.json: 7 strings",
			"Results: vitest 48 passed in src/features/variables; typecheck clean.",
			"Not done: the status filter, which is slice 2.",
		].join("\n"),
	},
	"the diff against main, Standards axis": {
		prompt: [
			"Review the diff against main on the Standards axis of REVIEW.md: naming, file layout, test style, i18n keys, dead code.",
			"List each finding as blocking or nit, with file:line. Fix nothing.",
		].join("\n"),
		reply: [
			"Standards review of the diff (7 files, +312 −4).",
			"Blocking: none.",
			"Nits:",
			"- ArchiveVariableDialog.tsx:18: onConfirmClick; REVIEW.md asks for onConfirm.",
			"- common.json (fr): variables.archive.cta repeats actions.archive; reuse it.",
			"- ArchiveVariable.test.tsx:52: the test name starts with 'should'; the suite states facts.",
			"Verdict: mergeable once the nits are fixed.",
		].join("\n"),
	},
	"the diff against the spec and FRCLM-58": {
		prompt: [
			"Check the diff against .scratch/frclm-58/spec.md and the acceptance criteria of FRCLM-58.",
			"For each criterion: met, partly met or missing, with the evidence.",
			"Flag anything built that the spec did not ask for.",
		].join("\n"),
		reply: [
			"Against FRCLM-58:",
			"1. Archive action, admins only: met (VariableRow.tsx:63, test 'hides the item from editors').",
			"2. The dialog names the variable and its drafts: met.",
			"3. Refused when a published estimation uses it: met, the estimations are linked (409 test).",
			"4. Archived variables leave the list, a filter shows them: partly. They leave the list; the filter is slice 2.",
			"Nothing built beyond the spec.",
			"Verdict: slice 1 matches the spec; criterion 4 waits for slice 2.",
		].join("\n"),
	},
};

const hex = (bytes) => randomBytes(bytes).toString("hex");
const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** The MCP servers every agent of the demo may call, as Copilot reports them: hashed. */
const MCP_AVAILABLE = JSON.stringify([sha256("github-mcp-server"), sha256("atlassian")]);

/** About how many tokens a tool's result adds to the context: what the next LLM call reads. */
function resultTokens(name, random) {
	const sizes = {
		"mcp:atlassian:getJiraIssue": [2800, 3600],
		"mcp:atlassian:getConfluencePage": [5200, 7400],
		"mcp:github-mcp-server:get_file_contents": [2400, 4200],
		read_file: [1200, 4000],
		grep_search: [500, 1500],
		run_in_terminal: [300, 1600],
	};
	const [low, high] = sizes[name] ?? [120, 300];
	return Math.round(low + random() * (high - low));
}

export function demoEnvelopes(t0, { seed = 1 } = {}) {
	let state = seed;
	const random = () => {
		state = (state * 16807) % 2147483647;
		return state / 2147483647;
	};
	const conversationId = randomUUID();
	const traceId = hex(16);
	const envelopes = [];

	const emit = (span) => {
		const publishAt = span.end + 800 + Math.round(random() * 1800);
		envelopes.push({ kind: "span", time: publishAt, data: { ...span, receivedAt: publishAt } });
	};

	const span = (name, parentSpanId, start, end, attributes) => {
		const record = {
			traceId,
			spanId: hex(8),
			parentSpanId,
			name,
			kind: 1,
			start: t0 + Math.round(start * 1000),
			end: t0 + Math.round(end * 1000),
			attributes: { "gen_ai.conversation.id": conversationId, ...attributes },
			status: { code: 0 },
			events: [],
			service: "github-copilot",
			scope: "github.copilot",
		};
		emit(record);
		return record;
	};

	const chat = (agentSpanId, tier, start, seconds, input, output, initiator) => {
		const model = MODELS[tier];
		const cacheRead = Math.round(input * (0.55 + random() * 0.35));
		const usd =
			((input - cacheRead) * model.price.input + cacheRead * model.price.cacheRead + output * model.price.output) / 1e6;
		span(`chat ${model.name}`, agentSpanId, start, start + seconds, {
			"gen_ai.operation.name": "chat",
			"gen_ai.provider.name": "github",
			"gen_ai.request.model": model.name,
			"gen_ai.response.model": model.name,
			"gen_ai.usage.input_tokens": input,
			"gen_ai.usage.output_tokens": output,
			"gen_ai.usage.cache_read.input_tokens": cacheRead,
			"gen_ai.usage.reasoning.output_tokens": Math.round(output * 0.4),
			"github.copilot.nano_aiu": Math.round((usd / 0.01) * 1e9),
			"github.copilot.initiator": initiator,
		});
		return start + seconds;
	};

	/** A tool call; `mcp:<server>:<tool>` is a call to an MCP server, its name hashed as Copilot does. */
	const tool = (agentSpanId, agentName, called, start, seconds, args) => {
		const mcp = /^mcp:([^:]+):(.+)$/.exec(called);
		const name = mcp ? `${mcp[1]}-${mcp[2]}` : called;
		const record = span(`execute_tool ${name}`, agentSpanId, start, start + seconds, {
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": name,
			"gen_ai.tool.call.id": `call_${hex(12)}`,
			"gen_ai.tool.type": mcp ? "extension" : "function",
			...(mcp
				? {
						"github.copilot.tool.parameters.mcp_server_name_hash": sha256(mcp[1]),
						"github.copilot.tool.parameters.mcp_tool_name": mcp[2],
					}
				: {}),
			"gen_ai.agent.name": agentName,
			...(args ? { "gen_ai.tool.call.arguments": JSON.stringify(args) } : {}),
		});
		if (name !== "manage_todo_list" && name !== "task") {
			span("permission", record.spanId, start, start, {
				"github.copilot.permission.kind": /edit|create|terminal/.test(name) ? "write" : "read",
				"github.copilot.permission.result": "approved",
			});
		}
		return record;
	};

	/** One subagent: a few rounds of LLM call then tools, started by a `task` call of the conductor. */
	const subagent = (rootSpanId, name, tier, start, rounds, tools, brief) => {
		const agentSpanId = hex(8);
		let clock = start + 0.2;
		// Each call reads the context so far: the brief, then every answer and tool result after it.
		let context = 2600 + Math.round(random() * 1800);
		for (let round = 0; round < rounds; round += 1) {
			const output = 120 + Math.round(random() * 700);
			clock = chat(agentSpanId, tier, clock, 1.2 + random() * 2.4, context, output, "sub-agent");
			context += output;
			const batch = tools.slice(round * 2, round * 2 + 2);
			for (const [toolName, args] of batch) {
				const seconds = toolName === "run_in_terminal" ? 2 + random() * 5 : 0.05 + random() * 0.3;
				tool(agentSpanId, name, toolName, clock, seconds, args);
				context += resultTokens(toolName, random);
				clock += seconds + 0.05;
			}
		}
		clock = chat(agentSpanId, tier, clock, 1 + random() * 2, context, 300 + Math.round(random() * 900), "sub-agent");
		const end = clock + 0.1;
		const task = span("execute_tool task", rootSpanId, start, end, {
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "task",
			"gen_ai.tool.call.id": `call_${hex(12)}`,
			"gen_ai.agent.name": "conductor",
			"gen_ai.tool.call.arguments": JSON.stringify({ agent_type: name, description: brief, prompt: HANDOFFS[brief]?.prompt }),
			...(HANDOFFS[brief] ? { "gen_ai.tool.call.result": HANDOFFS[brief].reply } : {}),
		});
		const record = {
			traceId,
			spanId: agentSpanId,
			parentSpanId: task.spanId,
			name: `invoke_agent ${name}`,
			kind: 1,
			start: t0 + Math.round(start * 1000),
			end: t0 + Math.round(end * 1000),
			attributes: {
				"gen_ai.conversation.id": conversationId,
				"gen_ai.operation.name": "invoke_agent",
				"gen_ai.agent.name": name,
				"github.copilot.agent.type": "custom",
				"github.copilot.context.mcp_server_names": MCP_AVAILABLE,
			},
			status: { code: 0 },
			events: [],
			service: "github-copilot",
			scope: "github.copilot",
		};
		emit(record);
		return end;
	};

	const todos = (rootSpanId, at, current) =>
		tool(rootSpanId, "conductor", "manage_todo_list", at, 0.05, {
			todoList: STEPS.map((title, index) => ({
				id: index + 1,
				title,
				status: index < current ? "completed" : index === current ? "in-progress" : "not-started",
			})),
		});

	const root = hex(8);
	let t = chat(root, "opus", 0, 3.2, 14_000, 420, "user");
	todos(root, t, 0);
	t += 0.2;
	const scouts = [
		["the ticket FRCLM-58 and the Confluence pages it cites", [["mcp:atlassian:getJiraIssue", { issueIdOrKey: "FRCLM-58" }], ["mcp:atlassian:getConfluencePage", { pageId: "FRCLM/Variables" }]]],
		["the code under src/features/variables", [["grep_search", { query: "VariableForm" }], ["read_file", { filePath: "src/features/variables/VariableForm.tsx" }], ["read_file", { filePath: "src/features/variables/api.ts" }]]],
		["the endpoints the ticket needs in src/api/schema.ts", [["grep_search", { query: "/variables/{id}/archive" }], ["read_file", { filePath: "src/api/schema.ts" }], ["mcp:github-mcp-server:get_file_contents", { owner: "acme", repo: "estimation-api", path: "CHANGELOG.md" }]]],
	];
	const scoutEnds = scouts.map(([brief, tools]) => subagent(root, "scout", "haiku", t, 3, tools, brief));
	t = Math.max(...scoutEnds) + 0.3;
	t = chat(root, "opus", t, 4.5, 26_000, 1400, "agent");
	todos(root, t, 3);
	t += 0.2;
	const ux = subagent(root, "ux-designer", "opus", t, 3, [["read_file", { filePath: ".scratch/frclm-58/spec.md" }], ["read_file", { filePath: "docs/agents/design-system.md" }], ["create_file", { filePath: ".scratch/frclm-58/ux.md" }]], "the archive action on the variables screen");
	const contract = subagent(root, "contract-keeper", "sonnet", t, 2, [["run_in_terminal", { command: "pnpm api:refresh" }], ["read_file", { filePath: "src/api/schema.ts" }]], "refresh the contract for POST /variables/{id}/archive");
	t = Math.max(ux, contract) + 0.3;
	t = chat(root, "opus", t, 2.4, 31_000, 600, "agent");
	t = subagent(root, "ui-designer", "sonnet", t + 0.2, 2, [["read_file", { filePath: ".scratch/frclm-58/ux.md" }], ["create_file", { filePath: ".scratch/frclm-58/components.md" }]], "plan mode: the components of the archive dialog") + 0.3;
	todos(root, t, 4);
	t += 0.2;
	t = subagent(root, "implementer", "sonnet5", t, 5, [
		["read_file", { filePath: "src/features/variables/VariableRow.tsx" }],
		["create_file", { filePath: "src/features/variables/ArchiveVariable.test.tsx" }],
		["run_in_terminal", { command: "pnpm vitest run src/features/variables" }],
		["replace_string_in_file", { filePath: "src/features/variables/VariableRow.tsx" }],
		["replace_string_in_file", { filePath: "src/locales/fr/common.json" }],
		["replace_string_in_file", { filePath: "src/locales/en/common.json" }],
		["run_in_terminal", { command: "pnpm vitest run src/features/variables" }],
		["run_in_terminal", { command: "pnpm typecheck" }],
	], "slice 1: archive a draft version's variable") + 0.3;
	todos(root, t, 5);
	t += 0.2;
	const standards = subagent(root, "standards-reviewer", "sonnet", t, 2, [["run_in_terminal", { command: "git diff main --stat" }], ["read_file", { filePath: "REVIEW.md" }]], "the diff against main, Standards axis");
	const spec = subagent(root, "spec-reviewer", "opus", t, 2, [["run_in_terminal", { command: "git diff main" }], ["read_file", { filePath: ".scratch/frclm-58/spec.md" }], ["mcp:atlassian:getJiraIssue", { issueIdOrKey: "FRCLM-58" }]], "the diff against the spec and FRCLM-58");
	t = Math.max(standards, spec) + 0.3;
	todos(root, t, 6);
	t = chat(root, "opus", t + 0.2, 3.8, 38_000, 1600, "agent");
	tool(root, "conductor", "run_in_terminal", t, 6, { command: "pnpm verify" });
	t = chat(root, "opus", t + 6.2, 2.2, 40_200, 500, "agent");
	tool(root, "conductor", "mcp:github-mcp-server:create_pull_request", t, 1.4, {
		owner: "acme",
		repo: "mk-consumption-estimation-dashboard-admin",
		title: "FRCLM-58 Archive a variable (slice 1)",
		head: DEMO_BRANCH,
		base: "main",
	});
	t = chat(root, "opus", t + 1.6, 1.8, 41_400, 300, "agent");
	tool(root, "conductor", "mcp:atlassian:addCommentToJiraIssue", t, 0.6, { issueIdOrKey: "FRCLM-58", body: "Slice 1 in review: archive a draft version's variable." });
	t = chat(root, "opus", t + 0.8, 2.6, 42_000, 900, "agent");
	envelopes.push({
		kind: "span",
		time: t0 + Math.round((t + 1.5) * 1000),
		data: {
			traceId,
			spanId: root,
			parentSpanId: null,
			name: "invoke_agent conductor",
			kind: 1,
			start: t0,
			end: t0 + Math.round(t * 1000),
			attributes: {
				"gen_ai.conversation.id": conversationId,
				"gen_ai.operation.name": "invoke_agent",
				"gen_ai.agent.name": "conductor",
				"github.copilot.agent.type": "custom",
				"github.copilot.context.mcp_server_names": MCP_AVAILABLE,
			},
			status: { code: 0 },
			events: [],
			service: "github-copilot",
			scope: "github.copilot",
			receivedAt: t0 + Math.round((t + 1.5) * 1000),
		},
	});
	return envelopes.sort((a, b) => a.time - b.time);
}
