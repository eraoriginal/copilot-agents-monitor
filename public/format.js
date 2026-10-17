export function formatDuration(ms) {
	if (!Number.isFinite(ms) || ms < 0) return "—";
	if (ms < 1000) return `${Math.round(ms)}ms`;
	const seconds = ms / 1000;
	if (seconds < 60) return `${seconds.toFixed(1)}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
}

export function formatTokens(n) {
	if (!Number.isFinite(n)) return "—";
	if (n < 1000) return String(n);
	if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
	return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Small amounts keep enough digits to tell one call from another. */
function formatAmount(value) {
	if (value === 0) return "0";
	if (value < 0.001) return value.toPrecision(2);
	if (value < 1) return value.toFixed(value < 0.01 ? 4 : 3);
	if (value < 100) return value.toFixed(2);
	return value.toFixed(0);
}

export function formatCredits(credits) {
	return credits == null ? "—" : `${formatAmount(credits)} cr`;
}

export function formatUsd(usd) {
	return usd == null ? "—" : `$${formatAmount(usd)}`;
}

export function formatClock(time) {
	if (!Number.isFinite(time)) return "—";
	return new Date(time).toLocaleTimeString([], { hour12: false });
}

export function formatPercent(part, whole) {
	if (!whole) return "—";
	return `${Math.round((part / whole) * 100)}%`;
}

/** `claude-opus-5.5` → `opus 5.5`; other names pass through. */
export function shortModel(model) {
	if (!model) return "?";
	const match = /claude-(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d+))?/i.exec(model);
	if (match) return `${match[1].toLowerCase()} ${match[2]}${match[3] ? `.${match[3]}` : ""}`;
	return model;
}
