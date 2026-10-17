/**
 * Lot 3: one summary per session, kept for good in `sessions.jsonl` while the spans themselves
 * are deleted after the retention period. A summary holds what the history needs: where the
 * session ran, on which branch and ticket, and what it cost, by agent and by model.
 *
 * The server feeds every event to a store of its own; a session is summarized again whenever it
 * changed and has been quiet for a while.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createStore, deriveSession, ingest } from "../public/model.js";
import { counterfactual } from "../public/routing.js";
import { placeOf } from "../public/workspaces.js";
import { appendRecord, parseLines } from "./store.js";

const QUIET_MS = 30_000;

export function summarize(view, place, pricing) {
	const byAgent = {};
	for (const agent of view.agents.values()) {
		if (agent.placeholder) continue;
		const entry = byAgent[agent.name] ?? { runs: 0, credits: 0, calls: 0, input: 0, output: 0 };
		entry.runs += 1;
		entry.credits += agent.totals.credits;
		entry.calls += agent.totals.calls;
		entry.input += agent.totals.input;
		entry.output += agent.totals.output;
		byAgent[agent.name] = entry;
	}
	const byModel = {};
	for (const [model, totals] of view.byModel) byModel[model] = { calls: totals.calls, credits: totals.credits };
	const alternative = counterfactual(view, pricing);
	return {
		id: view.id,
		title: view.title,
		prompt: view.prompt,
		startedAt: view.startedAt,
		lastActivityAt: view.lastActivityAt,
		wallMs: view.wallMs,
		turns: view.turns,
		agents: view.agents.size,
		subagents: view.subagents.length,
		workspace: place.workspacePath,
		workspaceName: place.workspaceName,
		branch: place.branch,
		branchGuessed: place.branchGuessed ?? false,
		ticket: place.ticket,
		totals: {
			credits: view.totals.credits,
			usd: view.totals.usd,
			input: view.totals.input,
			output: view.totals.output,
			cacheRead: view.totals.cacheRead,
			calls: view.totals.calls,
			tools: view.toolCount,
			estimated: view.totals.estimated > 0,
			unpriced: view.totals.unpriced,
		},
		baseline: alternative ? { model: alternative.baseline, credits: alternative.alternative } : null,
		byAgent,
		byModel,
	};
}

export function createHistory({ dataDir, workspaces, pricing }) {
	const file = join(dataDir, "sessions.jsonl");
	const summaries = new Map();
	if (existsSync(file)) {
		const lines = parseLines(readFileSync(file, "utf8"));
		for (const summary of lines) summaries.set(summary.id, summary);
		// Each update appends a line: rewrite the file once it holds mostly stale lines.
		if (lines.length > 2 * summaries.size + 50) {
			writeFileSync(file, [...summaries.values()].map((summary) => `${JSON.stringify(summary)}\n`).join(""));
		}
	}
	const store = createStore();
	const summarizedVersion = new Map();
	const touchedAt = new Map();

	const flush = (force = false) => {
		const now = Date.now();
		for (const session of store.sessions.values()) {
			if (summarizedVersion.get(session.id) === session.version) continue;
			if (!force && now - (touchedAt.get(session.id) ?? 0) < QUIET_MS) continue;
			const view = deriveSession(session, { now, pricing });
			summarizedVersion.set(session.id, session.version);
			if (view.agents.size === 0) continue;
			const place = placeOf(view, workspaces.list());
			const firstRecorded = place.workspace?.branchHistory?.[0]?.since;
			// Before the monitor first saw the workspace, its branch then is a guess.
			place.branchGuessed = Boolean(place.branch && firstRecorded && firstRecorded > view.startedAt);
			const summary = summarize(view, place, pricing);
			const previous = summaries.get(summary.id);
			if (previous?.branch) {
				// A session keeps the place it was first summarized with: the branch may have moved since.
				for (const key of ["workspace", "workspaceName", "branch", "ticket", "branchGuessed"]) summary[key] = previous[key];
			}
			if (previous && JSON.stringify(previous) === JSON.stringify(summary)) continue;
			summaries.set(summary.id, summary);
			appendRecord(dataDir, "sessions", summary, { daily: false });
		}
	};

	const timer = setInterval(() => flush(), 10_000);
	timer.unref();

	return {
		ingest(envelope) {
			ingest(store, envelope);
			const data = envelope.data ?? {};
			const id = data.attributes?.["gen_ai.conversation.id"] ?? data.traceId ?? data.session_id;
			if (id) touchedAt.set(id, Date.now());
		},
		/** Summarizes what was loaded at start, before any event arrives. */
		flushAll: () => flush(true),
		list: () => [...summaries.values()].sort((x, y) => y.startedAt - x.startedAt),
		stop: () => clearInterval(timer),
	};
}
