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

/**
 * What a root agent's tag says: its turn, or the turn it picks up again. A run the host started to
 * read the answers of the subagents a run launched belongs to that run's turn: it is not a new one.
 */
export function turnTag(agent, short = false) {
	if (agent.resumeOf) return short ? `↻t${agent.turn}` : `↻ resumes turn ${agent.turn}`;
	return short ? `t${agent.turn}` : `turn ${agent.turn}`;
}

export function turnTitle(agent) {
	return agent.resumeOf
		? `Turn ${agent.turn} of the conversation, started again by the agent host to read what the subagents sent back: not a new message`
		: `Turn ${agent.turn} of the conversation`;
}

/** The agent that reads `agent`'s answer: its launcher, or the later run of it that was started to read it. */
export function readerOf(view, agent) {
	return view.agents.get(agent.returnKey ?? agent.parentKey) ?? null;
}

/** Who launched `kid` and how far into its own run: `parent` is the agent that launched it. */
export function launchOf(parent, kid) {
	if (!parent || parent.virtual) return { launcher: null, offset: "" };
	return {
		launcher: parent.label,
		offset: `+${formatDuration(Math.max(0, kid.start - parent.start))}`,
	};
}
