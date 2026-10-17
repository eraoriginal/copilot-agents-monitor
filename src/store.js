import {
	appendFileSync,
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readdirSync,
	readFileSync,
	readSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { join } from "node:path";
import { dayFile, dayStamp } from "./config.js";

/** Appends to the day's file for `prefix`, or to `<prefix>.jsonl` for records kept for good. */
export function appendRecord(dir, prefix, record, { daily = true } = {}) {
	mkdirSync(dir, { recursive: true });
	const path = daily ? dayFile(dir, prefix) : join(dir, `${prefix}.jsonl`);
	appendFileSync(path, `${JSON.stringify(record)}\n`);
}

export function parseLines(text) {
	const records = [];
	for (const line of text.split("\n")) {
		if (line.trim() === "") continue;
		try {
			records.push(JSON.parse(line));
		} catch {
			// A line cut by a crash mid-write: skip it rather than lose the file.
		}
	}
	return records;
}

/** The records of the last `days` day files for `prefix`, oldest first. */
export function readRecentDays(dir, prefix, days, now = new Date()) {
	const records = [];
	for (let offset = days - 1; offset >= 0; offset -= 1) {
		const date = new Date(now);
		date.setDate(date.getDate() - offset);
		const path = dayFile(dir, prefix, date);
		if (existsSync(path)) records.push(...parseLines(readFileSync(path, "utf8")));
	}
	return records;
}

/** Deletes the day files older than `retentionDays`. Only files this tool writes match. */
export function purgeOldDays(dir, retentionDays, now = new Date()) {
	if (!existsSync(dir)) return [];
	const limit = new Date(now);
	limit.setDate(limit.getDate() - retentionDays);
	const oldest = dayStamp(limit);
	const removed = [];
	for (const name of readdirSync(dir)) {
		const match = /^(hooks|spans|logs)-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);
		if (match && match[2] < oldest) {
			unlinkSync(join(dir, name));
			removed.push(name);
		}
	}
	return removed;
}

/**
 * Follows the day file for `prefix` by polling: VS Code appends to it from another process, and
 * `fs.watch` is unreliable on Windows. Starts at the file's current end; switches file at midnight.
 */
export function tailDayFile(dir, prefix, onRecord, { intervalMs = 250 } = {}) {
	let path = dayFile(dir, prefix);
	let offset = existsSync(path) ? statSync(path).size : 0;
	let remainder = "";

	const poll = () => {
		const current = dayFile(dir, prefix);
		if (current !== path) {
			path = current;
			offset = 0;
			remainder = "";
		}
		if (!existsSync(path)) return;
		const size = statSync(path).size;
		if (size < offset) offset = 0;
		if (size === offset) return;
		const buffer = Buffer.alloc(size - offset);
		const fd = openSync(path, "r");
		try {
			readSync(fd, buffer, 0, buffer.length, offset);
		} finally {
			closeSync(fd);
		}
		offset = size;
		const text = remainder + buffer.toString("utf8");
		const lastNewline = text.lastIndexOf("\n");
		remainder = text.slice(lastNewline + 1);
		for (const record of parseLines(text.slice(0, lastNewline + 1))) onRecord(record);
	};

	const timer = setInterval(() => {
		try {
			poll();
		} catch (error) {
			console.error(`[agent-monitor] Could not read ${path}: ${error.message}`);
		}
	}, intervalMs);
	return () => clearInterval(timer);
}
