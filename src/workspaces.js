/**
 * The workspaces the monitor knows: the folders VS Code has opened (its `workspaceStorage`), the
 * ones passed with `--workspace` or listed in `~/.agent-monitor/config.json`, and those a hook
 * reported as its working directory. For each: its agents and the branch it is on, with every
 * branch change recorded so a past session keeps the branch it ran on.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir, platform } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseAgentFile } from "../public/routing.js";
import { appendRecord, parseLines } from "./store.js";

/** Where each VS Code flavor keeps one folder per workspace it has opened. */
export function workspaceStorageDirs(home = homedir(), os = platform(), env = process.env) {
	const flavors = ["Code", "Code - Insiders"];
	const base =
		os === "win32"
			? (env.APPDATA ?? join(home, "AppData", "Roaming"))
			: os === "darwin"
				? join(home, "Library", "Application Support")
				: (env.XDG_CONFIG_HOME ?? join(home, ".config"));
	return flavors.map((flavor) => join(base, flavor, "User", "workspaceStorage"));
}

function toPath(uri) {
	try {
		return uri.startsWith("file:") ? fileURLToPath(uri) : null;
	} catch {
		return null;
	}
}

/** The folders of every workspace VS Code recorded, multi-root `.code-workspace` files included. */
export function discoverFolders(storageDirs = workspaceStorageDirs()) {
	const folders = new Set();
	for (const storage of storageDirs) {
		if (!existsSync(storage)) continue;
		for (const entry of readdirSync(storage)) {
			const file = join(storage, entry, "workspace.json");
			if (!existsSync(file)) continue;
			try {
				const record = JSON.parse(readFileSync(file, "utf8"));
				if (record.folder) {
					const path = toPath(record.folder);
					if (path) folders.add(path);
				}
				if (record.workspace) {
					const workspaceFile = toPath(record.workspace);
					if (workspaceFile && existsSync(workspaceFile)) {
						// `.code-workspace` files allow comments and trailing commas: strip both.
						const text = readFileSync(workspaceFile, "utf8")
							.replace(/^\s*\/\/.*$/gm, "")
							.replace(/,(\s*[}\]])/g, "$1");
						for (const folder of JSON.parse(text).folders ?? []) {
							if (folder.path) folders.add(resolve(dirname(workspaceFile), folder.path));
						}
					}
				}
			} catch {
				// A record VS Code is writing, or a format it changed: skip it.
			}
		}
	}
	return [...folders];
}

/** The branch of the repository a folder belongs to; a worktree's `.git` file is followed. */
export function currentBranch(folder) {
	let dir = resolve(folder);
	for (;;) {
		const dotGit = join(dir, ".git");
		if (existsSync(dotGit)) {
			try {
				let gitDir = dotGit;
				if (statSync(dotGit).isFile()) {
					const pointer = /^gitdir:\s*(.+)$/m.exec(readFileSync(dotGit, "utf8"))?.[1]?.trim();
					if (!pointer) return null;
					gitDir = resolve(dir, pointer);
				}
				const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
				const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
				return ref ? ref[1] : head.slice(0, 12);
			} catch {
				return null;
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function readAgents(folder) {
	const dir = join(folder, ".github", "agents");
	if (!existsSync(dir)) return [];
	const agents = [];
	for (const name of readdirSync(dir)) {
		if (!/\.agent\.md$/i.test(name)) continue;
		try {
			agents.push(parseAgentFile(readFileSync(join(dir, name), "utf8"), name));
		} catch {
			// An unreadable file is one agent the monitor cannot check.
		}
	}
	return agents;
}

function readConfiguredFolders(dataDir) {
	const file = join(dataDir, "config.json");
	if (!existsSync(file)) return [];
	try {
		return JSON.parse(readFileSync(file, "utf8")).workspaces ?? [];
	} catch (error) {
		console.error(`[agent-monitor] ${file} is not valid JSON: ${error.message}`);
		return [];
	}
}

/**
 * Keeps the workspace list fresh: folders and agents every minute, branches every 15 seconds.
 * Branch changes are appended to `branches.jsonl`, so the history survives a restart.
 */
export function createWorkspaceRegistry({ dataDir, extraFolders = [], discover = true }) {
	const branchHistory = new Map();
	for (const record of existsSync(join(dataDir, "branches.jsonl"))
		? parseLines(readFileSync(join(dataDir, "branches.jsonl"), "utf8"))
		: []) {
		const history = branchHistory.get(record.path) ?? [];
		history.push({ since: record.since, branch: record.branch });
		branchHistory.set(record.path, history);
	}
	const hookFolders = new Set();
	let workspaces = [];

	const recordBranch = (path, branch) => {
		const history = branchHistory.get(path) ?? [];
		if (history.at(-1)?.branch === branch) return;
		const change = { since: Date.now(), branch };
		history.push(change);
		branchHistory.set(path, history);
		appendRecord(dataDir, "branches", { path, ...change }, { daily: false });
	};

	const refresh = () => {
		const folders = new Set([
			...(discover ? discoverFolders() : []),
			...readConfiguredFolders(dataDir),
			...extraFolders,
			...hookFolders,
		]);
		workspaces = [...folders]
			.filter((folder) => existsSync(folder))
			.map((folder) => {
				const path = resolve(folder);
				const branch = currentBranch(path);
				if (branch) recordBranch(path, branch);
				return {
					path,
					name: basename(path),
					agents: readAgents(path),
					branch,
					branchHistory: branchHistory.get(path) ?? [],
				};
			});
	};

	const refreshBranches = () => {
		for (const workspace of workspaces) {
			const branch = currentBranch(workspace.path);
			if (branch && branch !== workspace.branch) {
				workspace.branch = branch;
				recordBranch(workspace.path, branch);
				workspace.branchHistory = branchHistory.get(workspace.path);
			}
		}
	};

	refresh();
	const timers = [setInterval(refresh, 60_000), setInterval(refreshBranches, 15_000)];
	for (const timer of timers) timer.unref();

	return {
		list: () => workspaces,
		/** A hook's working directory is a workspace even if VS Code never recorded it. */
		addFolder(folder) {
			if (!folder || hookFolders.has(folder)) return;
			hookFolders.add(folder);
			refresh();
		},
		stop: () => timers.forEach(clearInterval),
	};
}
