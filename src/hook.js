#!/usr/bin/env node
/**
 * The hook command VS Code runs on every agent event (SessionStart, PreToolUse, SubagentStart…).
 *
 * It appends the event it receives on stdin to the day's hooks file and exits 0 without writing
 * to stdout. So it never blocks a tool call, never takes a permission decision another hook
 * should take, and works whether the monitor is running or not: the monitor catches up from the
 * file when it starts.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { clip } from "./clip.js";
import { dataDir, dayFile } from "./config.js";

try {
	const raw = readFileSync(0, "utf8");
	let event;
	try {
		event = JSON.parse(raw);
	} catch {
		event = { unparsed: raw };
	}
	const record = { receivedAt: Date.now(), cwd: process.cwd(), event: clip(event) };
	const dir = dataDir();
	mkdirSync(dir, { recursive: true });
	appendFileSync(dayFile(dir, "hooks"), `${JSON.stringify(record)}\n`);
} catch {
	// A monitor must never get in the agent's way.
}
process.exit(0);
