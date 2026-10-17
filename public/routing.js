/**
 * Lots 1 and 2: did each agent run on the model its `.agent.md` declares, and what would the
 * session have cost had every agent run on the root agent's model. No DOM, no Node.
 */

import { callUsage, priceFor } from "./model.js";

/** `Claude Opus 5.5 (copilot)` and `claude-opus-5.5` both become `claude-opus-5-5`. */
export function normalizeModel(name) {
	if (typeof name !== "string" || name.trim() === "") return null;
	return name
		.replace(/\([^)]*\)/g, "")
		.trim()
		.toLowerCase()
		.replace(/[\s._]+/g, "-")
		.replace(/-+/g, "-")
		.replace(/^-|-$/g, "");
}

/** A dated snapshot or a `-latest` alias is the same model; `sonnet-5` is not `sonnet-5-5`. */
const withoutSnapshot = (model) => model.replace(/-(\d{8}|latest|preview)$/, "");

function sameModel(actual, declared) {
	return withoutSnapshot(actual) === withoutSnapshot(declared);
}

function unquote(value) {
	const trimmed = value.trim();
	if (/^(['"]).*\1$/.test(trimmed)) return trimmed.slice(1, -1);
	return trimmed;
}

function inlineList(value) {
	const inner = value.trim().replace(/^\[|\]$/g, "");
	if (inner.trim() === "") return [];
	return inner.split(",").map(unquote).filter((item) => item.length > 0);
}

/**
 * Reads what the monitor needs from an agent file's front matter: name, description, models,
 * subagents. Only top-level keys and their scalar lists; nested maps (handoffs, hooks) are skipped.
 */
export function parseAgentFile(text, fileName = "") {
	const fallbackName = fileName.replace(/^.*[\\/]/, "").replace(/\.agent\.md$|\.md$/i, "");
	const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	const fields = {};
	if (match) {
		let listKey = null;
		for (const line of match[1].split(/\r?\n/)) {
			if (/^\s*#/.test(line) || line.trim() === "") continue;
			const top = /^([A-Za-z][\w-]*):\s*(.*)$/.exec(line);
			if (top) {
				const [, key, value] = top;
				listKey = null;
				if (value === "") {
					listKey = key;
					fields[key] = [];
				} else if (value.trim().startsWith("[")) {
					fields[key] = inlineList(value);
				} else {
					fields[key] = unquote(value);
				}
				continue;
			}
			const item = /^\s+-\s+(.*)$/.exec(line);
			if (listKey && item && !/^[\w-]+:\s/.test(item[1])) fields[listKey].push(unquote(item[1]));
			else if (listKey && item) listKey = null;
		}
	}
	const modelLabels = [].concat(fields.model ?? []).filter((label) => typeof label === "string" && label.length > 0);
	return {
		name: typeof fields.name === "string" && fields.name ? fields.name : fallbackName,
		description: typeof fields.description === "string" ? fields.description : null,
		modelLabels,
		models: modelLabels.map(normalizeModel).filter(Boolean),
		agents: [].concat(fields.agents ?? []),
		file: fileName,
	};
}

/**
 * One row per agent name: the models it ran on against those it declares.
 *   as-declared  every call on the first declared model
 *   fallback     every call on a declared model, some on a fallback
 *   off-list     some call on a model the file does not list
 *   undeclared   the file declares no model: the agent runs on its caller's or the picker's
 *   pending      no LLM call reported yet
 *   unknown      no agent file of that name in the session's workspace
 */
export function routingFor(view, definitions) {
	const byName = new Map();
	for (const agent of view.agents.values()) {
		if (agent.placeholder || agent.unnamed) continue;
		const entry = byName.get(agent.name) ?? { name: agent.name, root: agent.root, runs: 0, models: new Set(), calls: 0 };
		entry.runs += 1;
		entry.calls += agent.calls.length;
		for (const call of agent.calls) if (call.model) entry.models.add(call.model);
		byName.set(agent.name, entry);
	}
	return [...byName.values()].map((entry) => {
		const definition = definitions?.get(entry.name) ?? null;
		const actual = [...entry.models];
		const normalized = actual.map(normalizeModel);
		let status;
		if (!definition) status = "unknown";
		else if (definition.models.length === 0) status = "undeclared";
		else if (normalized.length === 0) status = "pending";
		else if (normalized.some((model) => !definition.models.some((declared) => sameModel(model, declared)))) status = "off-list";
		else if (normalized.every((model) => sameModel(model, definition.models[0]))) status = "as-declared";
		else status = "fallback";
		return {
			name: entry.name,
			root: entry.root,
			runs: entry.runs,
			actual,
			declared: definition?.modelLabels ?? [],
			status,
		};
	});
}

/** Weights that put input, cache and output on one scale when a model has no price. */
const WEIGHTS = { input: 1, cacheRead: 0.1, cacheWrite: 1.25, output: 5 };

function weighted(usage) {
	const uncached = Math.max(0, usage.input - usage.cacheRead - usage.cacheWrite);
	return (
		uncached * WEIGHTS.input +
		usage.cacheRead * WEIGHTS.cacheRead +
		usage.cacheWrite * WEIGHTS.cacheWrite +
		usage.output * WEIGHTS.output
	);
}

/**
 * The session's cost had every LLM call run on the root agent's main model, against what it
 * cost. An order of magnitude: another model would not have spent the same tokens.
 */
export function counterfactual(view, pricing) {
	const rootCalls = view.rootAgents.flatMap((agent) => agent.calls);
	if (rootCalls.length === 0) return null;
	const counts = new Map();
	for (const call of rootCalls) if (call.model) counts.set(call.model, (counts.get(call.model) ?? 0) + 1);
	const baseline = [...counts].sort((x, y) => y[1] - x[1])[0]?.[0];
	if (!baseline) return null;
	const baselineKey = normalizeModel(baseline);
	const price = priceFor(baseline, pricing);
	const usdPerCredit = pricing?.usdPerCredit ?? 0.01;

	let rate = null;
	if (!price) {
		// No list price: the rate the root agent's own calls were billed at, per weighted token.
		const own = rootCalls.filter((call) => normalizeModel(call.model) === baselineKey && call.usage.credits != null);
		const tokens = own.reduce((sum, call) => sum + weighted(call.usage), 0);
		const credits = own.reduce((sum, call) => sum + call.usage.credits, 0);
		if (tokens === 0) return null;
		rate = credits / tokens;
	}

	let actual = 0;
	let alternative = 0;
	let unpriced = 0;
	for (const agent of view.agents.values()) {
		for (const call of agent.calls) {
			if (call.usage.credits == null) {
				unpriced += 1;
				continue;
			}
			actual += call.usage.credits;
			if (normalizeModel(call.model) === baselineKey) {
				alternative += call.usage.credits;
			} else if (price) {
				const fake = { attributes: { "gen_ai.response.model": baseline, ...usageAttributes(call.usage) } };
				alternative += callUsage(fake, { ...pricing, models: { [baselineKey]: price } }).credits;
			} else {
				alternative += weighted(call.usage) * rate;
			}
		}
	}
	return {
		baseline,
		actual,
		alternative,
		usdPerCredit,
		saving: alternative > 0 ? 1 - actual / alternative : 0,
		estimatedRate: !price,
		unpriced,
	};
}

function usageAttributes(usage) {
	return {
		"gen_ai.usage.input_tokens": usage.input,
		"gen_ai.usage.output_tokens": usage.output,
		"gen_ai.usage.cache_read.input_tokens": usage.cacheRead,
		"gen_ai.usage.cache_write.input_tokens": usage.cacheWrite,
	};
}
