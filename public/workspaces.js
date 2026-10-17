/**
 * Which workspace a session ran in, on which branch, for which ticket. Spans from Copilot's
 * agent host name no folder, so a session is matched by the folder a hook reported, or else by
 * its agents: the workspace whose `.github/agents` defines every custom agent the session ran.
 * No DOM, no Node.
 */

const PLACEHOLDER_NAMES = new Set(["agent", "subagent", "orchestrator"]);

/** `feat/FRCLM-46-edit-configuration-version` → `FRCLM-46`. */
export function ticketOf(branch, pattern = /[A-Z][A-Z0-9]+-\d+/) {
	if (typeof branch !== "string") return null;
	return pattern.exec(branch)?.[0] ?? null;
}

const normalizePath = (path) => path.replaceAll("\\", "/").replace(/\/+$/, "").toLowerCase();

export function matchWorkspace(view, workspaces) {
	if (!workspaces?.length) return null;
	if (view.cwd) {
		const cwd = normalizePath(view.cwd);
		const byFolder = workspaces
			.filter((workspace) => cwd === normalizePath(workspace.path) || cwd.startsWith(`${normalizePath(workspace.path)}/`))
			.sort((x, y) => y.path.length - x.path.length)[0];
		if (byFolder) return byFolder;
	}
	const names = new Set(
		[...view.agents.values()]
			.filter((agent) => !agent.placeholder && !agent.unnamed && !PLACEHOLDER_NAMES.has(agent.name))
			.map((agent) => agent.name),
	);
	if (names.size === 0) return null;
	const candidates = workspaces.filter((workspace) => {
		const defined = new Set((workspace.agents ?? []).map((agent) => agent.name));
		return [...names].every((name) => defined.has(name));
	});
	// Several clones of one repository define the same agents: the one whose branch moved last.
	return candidates.sort((x, y) => (y.branchHistory?.at(-1)?.since ?? 0) - (x.branchHistory?.at(-1)?.since ?? 0))[0] ?? null;
}

/** The branch the workspace was on at `time`, from the changes the monitor recorded. */
export function branchAt(workspace, time) {
	if (!workspace) return null;
	const history = workspace.branchHistory ?? [];
	let branch = null;
	for (const change of history) {
		if (change.since <= time) branch = change.branch;
	}
	return branch ?? history[0]?.branch ?? workspace.branch ?? null;
}

export function definitionsOf(workspace) {
	return new Map((workspace?.agents ?? []).map((agent) => [agent.name, agent]));
}

/** Where a session ran, in one object the page and the history both use. */
export function placeOf(view, workspaces) {
	const workspace = matchWorkspace(view, workspaces);
	const branch = branchAt(workspace, view.startedAt);
	return {
		workspace,
		workspaceName: workspace?.name ?? null,
		workspacePath: workspace?.path ?? null,
		branch,
		ticket: ticketOf(branch),
	};
}
