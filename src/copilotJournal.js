/**
 * Copilot's own journal of a session: `~/.copilot/session-state/<session id>/events.jsonl`
 * (`COPILOT_HOME` moves `~/.copilot`). The agent host writes it whatever the hooks and the OTel
 * settings; the session ID is the conversation ID the spans carry.
 *
 * The monitor reads one thing there that spans do not report: how long the hooks took. Each hook is
 * a process the agent waits for, before and after its tool calls; their share of the agents'
 * working time is one of the session's indicators (`public/indicators.js`).
 *
 * Working time is the agents' turns, `assistant.turn_start` to `assistant.turn_end`, each agent on
 * its own: a model call and the tool calls it asked for. The time an agent waits for the user or for
 * its subagents is not in it. Hook time is the union of each agent's hook intervals, so hooks that
 * run side by side count once.
 *
 * Files grow while a session runs, to tens of megabytes: each read takes only the bytes appended
 * since the last one, and skips the lines that are not turns or hooks before parsing them.
 */

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { StringDecoder } from "node:string_decoder";

/** A session ID as Copilot writes it: never a path. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9-]{7,63}$/;
const CHUNK = 4 * 1024 * 1024;

export function journalPath(sessionId, env = process.env) {
	if (!SESSION_ID.test(String(sessionId))) return null;
	const home = env.COPILOT_HOME || join(homedir(), ".copilot");
	return join(home, "session-state", sessionId, "events.jsonl");
}

function emptyState() {
	return {
		offset: 0,
		// A read may end inside a character: the decoder keeps its first bytes for the next one.
		decoder: new StringDecoder("utf8"),
		remainder: "",
		hookStarts: new Map(),
		turnStarts: new Map(),
		// Per agent, the end of the last hook interval counted: hooks that overlap count once.
		hookEnds: new Map(),
		hookMs: 0,
		workMs: 0,
		byType: {},
	};
}

const timeOf = (event) => Date.parse(event.timestamp);

/** Folds one journal event into the state. */
function take(state, event) {
	const agent = event.agentId ?? "main";
	const time = timeOf(event);
	if (!Number.isFinite(time)) return;
	if (event.type === "assistant.turn_start") {
		state.turnStarts.set(agent, time);
	} else if (event.type === "assistant.turn_end") {
		const start = state.turnStarts.get(agent);
		if (start != null && time >= start) state.workMs += time - start;
		state.turnStarts.delete(agent);
	} else if (event.type === "hook.start") {
		const id = event.data?.hookInvocationId;
		if (id) state.hookStarts.set(id, { time, agent, type: event.data.hookType ?? "hook" });
	} else if (event.type === "hook.end") {
		const start = state.hookStarts.get(event.data?.hookInvocationId);
		if (!start || time < start.time) return;
		state.hookStarts.delete(event.data.hookInvocationId);
		const entry = (state.byType[start.type] ??= { count: 0, ms: 0 });
		entry.count += 1;
		entry.ms += time - start.time;
		const lastEnd = state.hookEnds.get(start.agent) ?? Number.NEGATIVE_INFINITY;
		if (time > lastEnd) state.hookMs += time - Math.max(start.time, lastEnd);
		state.hookEnds.set(start.agent, Math.max(lastEnd, time));
	}
}

function takeLines(state, text) {
	const lines = (state.remainder + text).split("\n");
	state.remainder = lines.pop() ?? "";
	for (const line of lines) {
		if (!line.includes('"hook.') && !line.includes('"assistant.turn_')) continue;
		try {
			take(state, JSON.parse(line));
		} catch {
			// A line cut by a crash: skip it rather than lose the file.
		}
	}
}

function summary(state) {
	return {
		hookMs: state.hookMs,
		workMs: state.workMs,
		share: state.workMs > 0 ? state.hookMs / state.workMs : 0,
		byType: structuredClone(state.byType),
	};
}

/**
 * Reads journals as they grow. `hooksOf(id)` returns `{ hookMs, workMs, share, byType }`, or null
 * when the session has no journal on this machine (another harness, another machine, a demo).
 */
export function createJournalReader({ env = process.env } = {}) {
	const states = new Map();
	return {
		hooksOf(sessionId) {
			const path = journalPath(sessionId, env);
			if (!path) return null;
			let size;
			try {
				size = statSync(path).size;
			} catch {
				return null;
			}
			let state = states.get(path);
			// A smaller file is another file: start over.
			if (!state || size < state.offset) {
				state = emptyState();
				states.set(path, state);
			}
			if (size > state.offset) {
				let fd;
				try {
					fd = openSync(path, "r");
					const buffer = Buffer.alloc(Math.min(CHUNK, size - state.offset));
					while (state.offset < size) {
						const read = readSync(fd, buffer, 0, Math.min(buffer.length, size - state.offset), state.offset);
						if (read <= 0) break;
						state.offset += read;
						takeLines(state, state.decoder.write(buffer.subarray(0, read)));
					}
				} catch {
					// Locked or gone for a moment: report what was read so far, read the rest next time.
				} finally {
					if (fd !== undefined) closeSync(fd);
				}
			}
			return state.workMs > 0 || state.hookMs > 0 ? summary(state) : null;
		},
	};
}
