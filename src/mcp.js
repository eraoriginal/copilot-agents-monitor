/**
 * The names of the MCP servers an agent may call, so that the page can name them. Copilot reports
 * a server as the SHA-256 of its name (in clear only with content capture); the monitor hashes the
 * names it can find and serves the table hash → name. It reads, never writes:
 *
 *   - VS Code's user `mcp.json` and `settings.json` (`mcp.servers`), profiles included;
 *   - the Copilot CLI's `~/.copilot/mcp-config.json`;
 *   - each known workspace's `.vscode/mcp.json`, `.vscode/settings.json` and `.mcp.json`;
 *   - a few names servers commonly go by, the CLI's built-in `github-mcp-server` first.
 */

import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { dirname, join } from "node:path";
import { workspaceStorageDirs } from "./workspaces.js";

/** Names servers commonly go by: GitHub's and Atlassian's, as their docs and galleries name them. */
export const KNOWN_SERVERS = [
	"github-mcp-server",
	"github",
	"GitHub",
	"github-remote",
	"github/github-mcp-server",
	"io.github.github/github-mcp-server",
	"atlassian",
	"Atlassian",
	"atlassian-mcp-server",
	"atlassian-remote",
	"mcp-atlassian",
	"com.atlassian/atlassian-mcp-server",
	"atlassian/atlassian-mcp-server",
	"jira",
	"confluence",
];

export const sha256 = (text) => createHash("sha256").update(text).digest("hex");

/** JSON with comments and trailing commas, as VS Code writes it. Strings are left alone. */
export function parseJsonc(text) {
	let out = "";
	let inString = false;
	for (let i = 0; i < text.length; i += 1) {
		const char = text[i];
		if (inString) {
			out += char;
			if (char === "\\") out += text[++i] ?? "";
			else if (char === '"') inString = false;
		} else if (char === '"') {
			inString = true;
			out += char;
		} else if (char === "/" && text[i + 1] === "/") {
			while (i < text.length && text[i] !== "\n") i += 1;
			out += "\n";
		} else if (char === "/" && text[i + 1] === "*") {
			i = text.indexOf("*/", i + 2);
			if (i < 0) break;
			i += 1;
		} else {
			out += char;
		}
	}
	return JSON.parse(out.replace(/,(\s*[}\]])/g, "$1"));
}

/** The server names a config file declares, under `servers`, `mcpServers` or `mcp.servers`. */
export function serverNamesIn(file) {
	if (!existsSync(file)) return [];
	try {
		const config = parseJsonc(readFileSync(file, "utf8"));
		const servers = config?.servers ?? config?.mcpServers ?? config?.["mcp.servers"] ?? config?.mcp?.servers ?? {};
		return typeof servers === "object" && servers ? Object.keys(servers) : [];
	} catch {
		// A file the monitor cannot read names no server: the page shows the hash instead.
		return [];
	}
}

/** Every config file that may declare MCP servers, for the user and for each workspace folder. */
export function configFiles({ folders = [], home = homedir(), os = platform(), env = process.env } = {}) {
	const files = [join(home, ".copilot", "mcp-config.json")];
	for (const storage of workspaceStorageDirs(home, os, env)) {
		const user = dirname(storage);
		files.push(join(user, "mcp.json"), join(user, "settings.json"));
		const profiles = join(user, "profiles");
		if (!existsSync(profiles)) continue;
		for (const profile of readdirSync(profiles)) {
			files.push(join(profiles, profile, "mcp.json"), join(profiles, profile, "settings.json"));
		}
	}
	for (const folder of folders) {
		files.push(join(folder, ".vscode", "mcp.json"), join(folder, ".vscode", "settings.json"), join(folder, ".mcp.json"));
	}
	return files;
}

/** hash → name for the known names and, unless `configs` is false, every configured one. */
export function mcpNameTable({ configs = true, ...where } = {}) {
	const names = new Set(KNOWN_SERVERS);
	if (configs) for (const file of configFiles(where)) for (const name of serverNamesIn(file)) names.add(name);
	return Object.fromEntries([...names].map((name) => [sha256(name), name]));
}

/** The table, worked out again at most every 30 seconds: configs change, workspaces come and go. */
export function createMcpNames({ folders = () => [], configs = true } = {}) {
	let cached = null;
	let at = 0;
	return {
		table() {
			if (!cached || Date.now() - at > 30_000) {
				cached = mcpNameTable({ configs, folders: folders() });
				at = Date.now();
			}
			return cached;
		},
	};
}
