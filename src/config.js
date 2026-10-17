import { homedir } from "node:os";
import { join } from "node:path";

export const DEFAULTS = {
	hosts: ["127.0.0.1", "::1"],
	otlpPort: 4318,
	uiPort: 4319,
	demoPort: 4329,
	historyDays: 2,
	retentionDays: 14,
};

/** Where hook events and received spans are kept: `~/.agent-monitor`, or `AGENT_MONITOR_HOME`. */
export function dataDir(env = process.env) {
	return env.AGENT_MONITOR_HOME || join(homedir(), ".agent-monitor");
}

/** The local calendar day, `YYYY-MM-DD`: one file per day keeps retention a matter of deleting files. */
export function dayStamp(date = new Date()) {
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

export function dayFile(dir, prefix, date = new Date()) {
	return join(dir, `${prefix}-${dayStamp(date)}.jsonl`);
}
