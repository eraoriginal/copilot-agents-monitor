/**
 * The shape of the orchestration tree: which agents an agent launched, which of them ran side by
 * side, and who launched whom. No DOM, no Node.
 */

import { formatDuration } from "./format.js";

/** The agents `agent` launched, in the order they started. */
export function childrenOf(view, agent) {
	return agent.children
		.map((key) => view.agents.get(key))
		.filter(Boolean)
		.sort((x, y) => x.start - y.start);
}

/**
 * Agents that ran alongside one another form a wave; one that started after the previous ones
 * had finished opens the next wave. Returns, for each agent in `kids`, whether it opens one.
 */
export function waveStarts(kids, now) {
	let waveEnd = Number.NEGATIVE_INFINITY;
	return kids.map((kid, index) => {
		const end = kid.done && kid.end ? kid.end : now;
		const opensWave = index > 0 && kid.start >= waveEnd - 50;
		waveEnd = index === 0 || opensWave ? end : Math.max(waveEnd, end);
		return opensWave;
	});
}

/** The agents of `kids` split into waves, in order: each wave is a list of agents that ran together. */
export function groupWaves(kids, now) {
	const opens = waveStarts(kids, now);
	const waves = [];
	for (const [index, kid] of kids.entries()) {
		if (index === 0 || opens[index]) waves.push({ key: kid.key, agents: [] });
		waves.at(-1).agents.push(kid);
	}
	return waves;
}

/** Who launched `kid` and how far into its own run: `parent` is the agent that launched it. */
export function launchOf(parent, kid) {
	if (!parent || parent.virtual) return { launcher: null, offset: "" };
	return {
		launcher: parent.label,
		offset: `+${formatDuration(Math.max(0, kid.start - parent.start))}`,
	};
}
