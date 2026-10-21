/**
 * Four indicators of a session, each with the target it is read against: what the session cost,
 * how often its root agent woke up to a cold cache, how large an agent's context grew, and how
 * much of the agents' working time went to hooks. Shared by the page and the history; no DOM, no
 * Node.
 *
 * The first three come from the derived view (see `deriveSession` in model.js). The hooks' share
 * comes from Copilot's own journal, which only the server reads: it is passed in, or null.
 */

export const TARGETS = {
	/** Tokens a wake-up rewrites: what the root agent's context weighs when its cache has expired. */
	wakeUpTokens: 60_000,
	/** The largest prompt one agent run sends. */
	contextTokens: 150_000,
	/** Hooks' time over the agents' working time. */
	hookShare: 0.05,
};

// A call that writes most of a large prompt to the cache found it cold. Prompt caches last five
// minutes for Claude models in Copilot: a root agent that waits longer for its subagents or for
// the user pays for its whole context again on the next call.
const COLD_SHARE = 0.5;
const COLD_MIN_INPUT = 30_000;

export function isColdCall(usage) {
	return usage.input >= COLD_MIN_INPUT && usage.cacheWrite >= COLD_SHARE * usage.input;
}

/**
 * The root agent's wake-ups: its calls, across turns, that rewrote a cold cache. The first call of
 * the session is left out: nothing could have been cached before it.
 */
export function wakeUpsOf(view) {
	const calls = view.rootAgents.flatMap((agent) => agent.calls).sort((x, y) => x.start - y.start);
	const cold = calls.slice(1).filter((call) => isColdCall(call.usage));
	const tokens = cold.reduce((sum, call) => sum + call.usage.cacheWrite, 0);
	return {
		count: cold.length,
		tokens,
		average: cold.length ? tokens / cold.length : 0,
		largest: cold.reduce((max, call) => Math.max(max, call.usage.cacheWrite), 0),
		credits: cold.reduce((sum, call) => sum + (call.usage.credits ?? 0), 0),
	};
}

/** The largest prompt each agent run sent, largest first. */
export function contextsOf(view) {
	// The root agent runs once per turn: when it ran more than once, the turn tells its runs apart.
	const turns = view.rootAgents.length > 1;
	return [...view.agents.values()]
		.filter((agent) => agent.calls.length > 0)
		.map((agent) => ({
			key: agent.key,
			label: turns && agent.root && agent.turn ? `${agent.name} · turn ${agent.turn}` : (agent.label ?? agent.name),
			name: agent.name,
			root: agent.root,
			max: Math.max(...agent.calls.map((call) => call.usage.input)),
		}))
		.sort((x, y) => y.max - x.max);
}

/** `hooks`: the server's reading of Copilot's journal, `{ hookMs, workMs, share }`, or null. */
export function sessionIndicators(view, hooks = null) {
	const wakeUps = wakeUpsOf(view);
	const contexts = contextsOf(view);
	return {
		credits: view.totals.credits,
		wakeUps: { ...wakeUps, over: wakeUps.count > 0 && wakeUps.average > TARGETS.wakeUpTokens },
		context: {
			max: contexts[0]?.max ?? 0,
			agent: contexts[0]?.label ?? null,
			runs: contexts.slice(0, 5),
			over: (contexts[0]?.max ?? 0) > TARGETS.contextTokens,
		},
		hooks: hooks ? { ...hooks, over: hooks.share > TARGETS.hookShare } : null,
	};
}
