/**
 * `--demo`: a conductor run replayed live, with spans shaped like those Copilot's agent host
 * exports. It runs the team of a conductor-and-specialists setup — three scouts in parallel,
 * designers, an implementer, two reviewers — on Haiku, Sonnet and Opus, over about two minutes.
 *
 * Each span is published a second or two after it ends, as the OTLP batch exporter would. The
 * todo list and the briefs carry tool arguments, which a real run reports only with hooks or
 * content capture on.
 */

import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

const PRICES = JSON.parse(readFileSync(new URL("./pricing.json", import.meta.url), "utf8")).models;
const MODELS = {
	opus: { name: "claude-opus-5.5", price: PRICES["claude-opus-5-5"] },
	sonnet: { name: "claude-sonnet-5.5", price: PRICES["claude-sonnet-5-5"] },
	haiku: { name: "claude-haiku-5.5", price: PRICES["claude-haiku-5-5"] },
};

const STEPS = ["Intake", "Grill", "Specify", "Design", "Build", "Review", "Close"];

const hex = (bytes) => randomBytes(bytes).toString("hex");

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

	const tool = (agentSpanId, agentName, name, start, seconds, args) => {
		const record = span(`execute_tool ${name}`, agentSpanId, start, start + seconds, {
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": name,
			"gen_ai.tool.call.id": `call_${hex(12)}`,
			"gen_ai.tool.type": "function",
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
		const used = [];
		for (let round = 0; round < rounds; round += 1) {
			clock = chat(agentSpanId, tier, clock, 1.2 + random() * 2.4, 2400 + Math.round(random() * 9000), 120 + Math.round(random() * 700), "sub-agent");
			const batch = tools.slice(round * 2, round * 2 + 2);
			for (const [toolName, args] of batch) {
				const seconds = toolName === "run_in_terminal" ? 2 + random() * 5 : 0.05 + random() * 0.3;
				tool(agentSpanId, name, toolName, clock, seconds, args);
				used.push(toolName);
				clock += seconds + 0.05;
			}
		}
		clock = chat(agentSpanId, tier, clock, 1 + random() * 2, 3000 + Math.round(random() * 6000), 300 + Math.round(random() * 900), "sub-agent");
		const end = clock + 0.1;
		const task = span("execute_tool task", rootSpanId, start, end, {
			"gen_ai.operation.name": "execute_tool",
			"gen_ai.tool.name": "task",
			"gen_ai.tool.call.id": `call_${hex(12)}`,
			"gen_ai.agent.name": "conductor",
			"gen_ai.tool.call.arguments": JSON.stringify({ agent_type: name, description: brief }),
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
		["the ticket FRCLM-58 and the Confluence pages it cites", [["search_jira", { query: "FRCLM-58" }], ["read_page", { path: "FRCLM/Variables" }]]],
		["the code under src/features/variables", [["grep_search", { query: "VariableForm" }], ["read_file", { filePath: "src/features/variables/VariableForm.tsx" }], ["read_file", { filePath: "src/features/variables/api.ts" }]]],
		["the endpoints the ticket needs in src/api/schema.ts", [["grep_search", { query: "/variables/{id}/archive" }], ["read_file", { filePath: "src/api/schema.ts" }]]],
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
	t = subagent(root, "implementer", "sonnet", t, 5, [
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
	const spec = subagent(root, "spec-reviewer", "opus", t, 2, [["run_in_terminal", { command: "git diff main" }], ["read_file", { filePath: ".scratch/frclm-58/spec.md" }]], "the diff against the spec and FRCLM-58");
	t = Math.max(standards, spec) + 0.3;
	todos(root, t, 6);
	t = chat(root, "opus", t + 0.2, 3.8, 38_000, 1600, "agent");
	tool(root, "conductor", "run_in_terminal", t, 6, { command: "pnpm verify" });
	t = chat(root, "opus", t + 6.2, 2.6, 40_000, 900, "agent");
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
