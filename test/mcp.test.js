import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { mcpNameTable, parseJsonc, serverNamesIn, sha256 } from "../src/mcp.js";

test("Copilot's built-in GitHub server is known by the hash its spans carry", () => {
	const table = mcpNameTable({ configs: false });
	assert.equal(table["4c96a3dc55eb446a58524cf5336260ffb09488a0e0ce48bff0368c261d2f7f6e"], "github-mcp-server");
	assert.equal(table[sha256("atlassian")], "atlassian");
});

test("VS Code's JSON with comments and trailing commas is read, strings left whole", () => {
	const config = parseJsonc(`{
		// a comment
		"servers": { "a": { "url": "https://example.test//path" }, /* another */ },
	}`);
	assert.deepEqual(Object.keys(config.servers), ["a"]);
	assert.equal(config.servers.a.url, "https://example.test//path");
});

test("server names are read from every config the user and the workspaces keep", () => {
	const home = mkdtempSync(join(tmpdir(), "mcp-home-"));
	const workspace = mkdtempSync(join(tmpdir(), "mcp-workspace-"));
	try {
		const user = join(home, ".config", "Code", "User");
		mkdirSync(join(user, "profiles", "work"), { recursive: true });
		mkdirSync(join(home, ".copilot"), { recursive: true });
		mkdirSync(join(workspace, ".vscode"), { recursive: true });
		writeFileSync(join(user, "mcp.json"), `{ "servers": { "my-jira": {} } }`);
		writeFileSync(join(user, "settings.json"), `{ "mcp": { "servers": { "from-settings": {} } }, // trailing\n }`);
		writeFileSync(join(user, "profiles", "work", "mcp.json"), `{ "servers": { "profile-server": {} } }`);
		writeFileSync(join(home, ".copilot", "mcp-config.json"), `{ "mcpServers": { "cli-server": {} } }`);
		writeFileSync(join(workspace, ".vscode", "mcp.json"), `{ "servers": { "team-confluence": {} } }`);
		writeFileSync(join(workspace, ".mcp.json"), `{ "mcpServers": { "project-server": {} } }`);
		const table = mcpNameTable({ home, os: "linux", env: {}, folders: [workspace] });
		for (const name of ["my-jira", "from-settings", "profile-server", "cli-server", "team-confluence", "project-server"]) {
			assert.equal(table[sha256(name)], name, name);
		}
		// A broken file names nothing, and breaks nothing.
		writeFileSync(join(workspace, ".mcp.json"), "{ not json");
		assert.deepEqual(serverNamesIn(join(workspace, ".mcp.json")), []);
	} finally {
		rmSync(home, { recursive: true, force: true });
		rmSync(workspace, { recursive: true, force: true });
	}
});
