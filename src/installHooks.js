#!/usr/bin/env node
/**
 * Installs the monitor's hook for every workspace: `~/.copilot/hooks/agent-monitor.json`, which
 * VS Code reads in both harnesses. Hooks bring what spans cannot: the moment an agent starts, and
 * the user's prompt.
 *
 * By default the hook takes only the events that happen a few times per turn. Tool calls are left
 * out: the host starts a process for each hook it runs, before and after every tool call, which
 * cost 1 to 2 seconds per call on Windows. Spans with content capture
 * (`chat.agentHost.otel.captureContent`) carry the same arguments and results at no such cost.
 * `--tools` adds PreToolUse and PostToolUse back, for a machine where content capture is off.
 *
 *   npm run install-hooks                    shows the file and where it would go; changes nothing
 *   npm run install-hooks -- --yes           writes it
 *   npm run install-hooks -- --yes --tools   writes it with the tool-call events
 *   npm run install-hooks -- --remove        deletes it, if it is the one this command wrote
 */

import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const MARKER = "agent-monitor";
/** A few per turn: their cost is negligible. */
const EVENTS = ["SessionStart", "UserPromptSubmit", "PreCompact", "SubagentStart", "SubagentStop", "Stop"];
/** One process before and one after every tool call: only with `--tools`. */
const TOOL_EVENTS = ["PreToolUse", "PostToolUse"];

const { values: args } = parseArgs({
	options: {
		yes: { type: "boolean", default: false },
		remove: { type: "boolean", default: false },
		tools: { type: "boolean", default: false },
	},
});
const events = args.tools ? [...EVENTS, ...TOOL_EVENTS] : EVENTS;

const target = join(homedir(), ".copilot", "hooks", `${MARKER}.json`);
const hookScript = fileURLToPath(new URL("./hook.js", import.meta.url));
// The node that runs this command, by absolute path: a hook's PATH is not always the shell's.
const command = `"${process.execPath}" "${hookScript}"`;
// PowerShell reads a line that starts with a quoted string as a value, not a command: without the
// call operator the hook fails to parse, exits 1, and a failing PreToolUse denies every tool call.
const entry = {
	type: "command",
	command,
	bash: command,
	powershell: `& ${command}`,
	timeout: 5,
	timeoutSec: 5,
};
const config = {
	version: 1,
	$comment: `Written by ${MARKER} (npm run install-hooks). Appends each event to ~/.agent-monitor; never blocks, never decides.`,
	hooks: Object.fromEntries(events.map((event) => [event, [entry]])),
};

if (args.remove) {
	if (!existsSync(target)) {
		console.log(`Nothing to remove: ${target} does not exist.`);
	} else if (!readFileSync(target, "utf8").includes(`Written by ${MARKER}`)) {
		console.error(`${target} was not written by this command; left as it is.`);
		process.exit(1);
	} else {
		unlinkSync(target);
		console.log(`Removed ${target}.`);
	}
	process.exit(0);
}

const content = `${JSON.stringify(config, null, "\t")}\n`;
if (!args.yes) {
	console.log(`Would write ${target}:\n\n${content}`);
	console.log("These hooks run in every workspace you open. Run again with --yes to write the file.");
	process.exit(0);
}

mkdirSync(join(homedir(), ".copilot", "hooks"), { recursive: true });
writeFileSync(target, content);
console.log(`Wrote ${target}. VS Code picks it up for new chat sessions.`);
