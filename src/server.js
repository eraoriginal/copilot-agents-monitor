#!/usr/bin/env node
/**
 * agent-monitor: one process, two local ports.
 *
 * - The OTLP receiver (default 4318, Copilot Chat's default endpoint) takes the spans VS Code
 *   exports when `github.copilot.chat.otel.enabled` is on: agents, LLM calls with their tokens,
 *   tool calls.
 * - The UI server (default 4319) serves the page and streams every event to it over SSE.
 *
 * Hook events arrive through a file: `src/hook.js` appends them, this process tails it.
 */

import {
	createReadStream,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync, inflateSync } from "node:zlib";
import { DEFAULTS, dataDir } from "./config.js";
import { createHistory } from "./history.js";
import { createMcpNames } from "./mcp.js";
import { flattenLogs, flattenTraces } from "./otlp.js";
import { appendRecord, purgeOldDays, readRecentDays, tailDayFile } from "./store.js";
import { createWorkspaceRegistry } from "./workspaces.js";

const PUBLIC_DIR = resolve(fileURLToPath(new URL("../public", import.meta.url)));
/** Copilot reports cost in AI credits; GitHub prices one credit at a cent. */
const USD_PER_CREDIT = 0.01;
const pricing = {
	usdPerCredit: USD_PER_CREDIT,
	models: JSON.parse(readFileSync(new URL("./pricing.json", import.meta.url), "utf8")).models,
};
const MAX_BODY_BYTES = 32 * 1024 * 1024;
const CONTENT_TYPES = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript; charset=utf-8",
	".css": "text/css; charset=utf-8",
	".json": "application/json; charset=utf-8",
	".svg": "image/svg+xml",
};

const { values: args } = parseArgs({
	options: {
		"otlp-port": { type: "string", default: String(DEFAULTS.otlpPort) },
		"ui-port": { type: "string" },
		days: { type: "string", default: String(DEFAULTS.historyDays) },
		retention: { type: "string", default: String(DEFAULTS.retentionDays) },
		raw: { type: "boolean", default: false },
		demo: { type: "boolean", default: false },
		workspace: { type: "string", multiple: true, default: [] },
	},
});

const otlpPort = Number(args["otlp-port"]);
// The demo takes its own port, so it can run beside the real monitor.
const uiPort = Number(args["ui-port"] ?? (args.demo ? DEFAULTS.demoPort : DEFAULTS.uiPort));
const dir = dataDir();
mkdirSync(dir, { recursive: true });

// ---------------------------------------------------------------------------------------------
// The event log: every hook event, span and log record, in arrival order, numbered.

const envelopes = [];
const clients = new Set();
const status = { hooks: 0, spans: 0, logs: 0, lastHookAt: null, lastSpanAt: null, protobufRefused: 0 };

function hookEnvelope(record) {
	const event = record.event ?? {};
	const time = Date.parse(event.timestamp) || record.receivedAt;
	return { kind: "hook", time, data: { ...event, cwd: event.cwd ?? record.cwd } };
}

// The workspaces and the session history; the demo brings its own of both.
let workspaces = null;
let history = null;
// The names of the MCP servers, by the SHA-256 Copilot reports them as.
let mcpNames = null;

/** `live`: an event as it arrives, which the history also takes; not one reloaded at start. */
function publish(envelope, { live = true } = {}) {
	const numbered = { seq: envelopes.length + 1, ...envelope };
	envelopes.push(numbered);
	const frame = `id: ${numbered.seq}\ndata: ${JSON.stringify(numbered)}\n\n`;
	for (const client of clients) client.write(frame);
	if (live) history?.ingest(envelope);
	if (envelope.kind === "hook") workspaces?.addFolder(envelope.data.cwd);
	return numbered;
}

/**
 * Reads the retained day files once: the history summarizes all of them, the page receives the
 * last `pageDays` days.
 */
function loadRecorded(pageDays, retentionDays) {
	const recorded = [
		...readRecentDays(dir, "hooks", retentionDays).map(hookEnvelope),
		...readRecentDays(dir, "spans", retentionDays).map((span) => ({
			kind: "span",
			time: span.end ?? span.start,
			data: span,
		})),
		...readRecentDays(dir, "logs", retentionDays).map((log) => ({ kind: "log", time: log.time, data: log })),
	].sort((a, b) => a.time - b.time);
	const cutoff = new Date();
	cutoff.setHours(0, 0, 0, 0);
	cutoff.setDate(cutoff.getDate() - (pageDays - 1));
	let published = 0;
	for (const envelope of recorded) {
		history?.ingest(envelope);
		if (envelope.time >= cutoff.getTime()) {
			publish(envelope, { live: false });
			published += 1;
		}
	}
	history?.flushAll();
	return { recorded: recorded.length, published };
}

function onHookRecord(record) {
	status.hooks += 1;
	status.lastHookAt = Date.now();
	if (status.hooks === 1) console.log("[agent-monitor] First hook event received.");
	publish(hookEnvelope(record));
}

// ---------------------------------------------------------------------------------------------
// Shared HTTP helpers.

/** Only local names: a page on another site cannot reach this server by rebinding a DNS name. */
function isLocalHost(request, port) {
	const host = request.headers.host ?? "";
	return [`localhost:${port}`, `127.0.0.1:${port}`, `[::1]:${port}`].includes(host);
}

function readBody(request) {
	return new Promise((resolveBody, reject) => {
		const chunks = [];
		let size = 0;
		request.on("data", (chunk) => {
			size += chunk.length;
			if (size > MAX_BODY_BYTES) {
				reject(new Error("Body too large"));
				request.destroy();
				return;
			}
			chunks.push(chunk);
		});
		request.on("end", () => {
			const buffer = Buffer.concat(chunks);
			const encoding = request.headers["content-encoding"];
			if (encoding === "gzip") resolveBody(gunzipSync(buffer));
			else if (encoding === "deflate") resolveBody(inflateSync(buffer));
			else resolveBody(buffer);
		});
		request.on("error", reject);
	});
}

function sendJson(response, code, body) {
	response.writeHead(code, { "content-type": "application/json" });
	response.end(JSON.stringify(body));
}

// ---------------------------------------------------------------------------------------------
// The OTLP receiver.

function saveRaw(signal, body) {
	if (!args.raw) return;
	const rawDir = join(dir, "raw");
	mkdirSync(rawDir, { recursive: true });
	writeFileSync(join(rawDir, `${signal}-${Date.now()}.json`), body);
}

async function handleOtlp(request, response) {
	if (!isLocalHost(request, otlpPort)) return sendJson(response, 403, { error: "Local only" });
	const signal = { "/v1/traces": "traces", "/v1/logs": "logs", "/v1/metrics": "metrics" }[
		request.url?.split("?")[0]
	];
	if (request.method !== "POST" || !signal) return sendJson(response, 404, {});

	if (String(request.headers["content-type"]).includes("protobuf")) {
		status.protobufRefused += 1;
		if (status.protobufRefused === 1) {
			console.warn(
				"[agent-monitor] Received OTLP protobuf. Set github.copilot.chat.otel.protocol to http/json (its default).",
			);
		}
		return sendJson(response, 415, { error: "Use http/json" });
	}

	let body;
	try {
		const buffer = await readBody(request);
		saveRaw(signal, buffer);
		body = JSON.parse(buffer.toString("utf8"));
	} catch (error) {
		return sendJson(response, 400, { error: error.message });
	}

	const receivedAt = Date.now();
	if (signal === "traces") {
		for (const span of flattenTraces(body)) {
			// How late a span arrives: the exporter batches, so the live view lags by this much.
			span.receivedAt = receivedAt;
			status.spans += 1;
			status.lastSpanAt = Date.now();
			if (status.spans === 1) console.log("[agent-monitor] First span received.");
			appendRecord(dir, "spans", span);
			publish({ kind: "span", time: span.end ?? span.start, data: span });
		}
	} else if (signal === "logs") {
		for (const log of flattenLogs(body)) {
			status.logs += 1;
			appendRecord(dir, "logs", log);
			publish({ kind: "log", time: log.time, data: log });
		}
	}
	return sendJson(response, 200, { partialSuccess: {} });
}

// ---------------------------------------------------------------------------------------------
// The UI server: static files, the status, and the event stream.

function serveStatic(request, response) {
	const pathname = decodeURIComponent(new URL(request.url, "http://localhost").pathname);
	const relative = pathname === "/" ? "index.html" : pathname.slice(1);
	const file = normalize(join(PUBLIC_DIR, relative));
	if (!file.startsWith(PUBLIC_DIR + sep) || !existsSync(file)) {
		response.writeHead(404);
		response.end();
		return;
	}
	response.writeHead(200, {
		"content-type": CONTENT_TYPES[extname(file)] ?? "application/octet-stream",
		"content-security-policy":
			"default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:",
		"x-content-type-options": "nosniff",
		"cache-control": "no-store",
	});
	createReadStream(file).pipe(response);
}

function serveStream(request, response) {
	const url = new URL(request.url, "http://localhost");
	const since = Number(request.headers["last-event-id"] ?? url.searchParams.get("since") ?? 0);
	response.writeHead(200, {
		"content-type": "text/event-stream",
		"cache-control": "no-store",
		connection: "keep-alive",
	});
	for (const envelope of envelopes.slice(since)) {
		response.write(`id: ${envelope.seq}\ndata: ${JSON.stringify(envelope)}\n\n`);
	}
	clients.add(response);
	const heartbeat = setInterval(() => response.write(": keep-alive\n\n"), 15_000);
	request.on("close", () => {
		clearInterval(heartbeat);
		clients.delete(response);
	});
}

function handleUi(request, response) {
	if (!isLocalHost(request, uiPort)) return sendJson(response, 403, { error: "Local only" });
	const pathname = new URL(request.url, "http://localhost").pathname;
	if (pathname === "/api/stream") return serveStream(request, response);
	if (pathname === "/api/status") {
		return sendJson(response, 200, { ...status, dataDir: dir, otlpPort, uiPort, demo: args.demo });
	}
	if (pathname === "/api/config") return sendJson(response, 200, pricing);
	if (pathname === "/api/workspaces") return sendJson(response, 200, workspaces?.list() ?? []);
	if (pathname === "/api/history") return sendJson(response, 200, history?.list() ?? []);
	if (pathname === "/api/mcp") return sendJson(response, 200, mcpNames?.table() ?? {});
	return serveStatic(request, response);
}

// ---------------------------------------------------------------------------------------------
// Start.

/**
 * Listens on both loopback addresses: `localhost` resolves to `::1` first on Windows, so an
 * exporter pointed at `http://localhost:4318` never reaches a server bound to 127.0.0.1 alone.
 * Nothing listens beyond the loopback interface.
 */
function listen(handler, port, label) {
	for (const host of DEFAULTS.hosts) {
		const server = createServer(handler);
		server.on("error", (error) => {
			if (error.code === "EADDRNOTAVAIL" || error.code === "EAFNOSUPPORT") return;
			if (error.code === "EADDRINUSE") {
				console.error(
					`[agent-monitor] Port ${port} (${label}) is already in use on ${host}. Pass --${label}-port <port>.`,
				);
				process.exit(1);
			}
			throw error;
		});
		server.listen(port, host);
	}
}

const removed = purgeOldDays(dir, Number(args.retention));
if (removed.length > 0) console.log(`[agent-monitor] Removed ${removed.length} old day file(s).`);

if (args.demo) {
	const demo = await import("./demo.js");
	const start = Date.now();
	// The demo's history lives in a throwaway folder: it never mixes with the real one.
	const demoDir = mkdtempSync(join(tmpdir(), "agent-monitor-demo-"));
	process.on("exit", () => rmSync(demoDir, { recursive: true, force: true }));
	for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(0));
	writeFileSync(
		join(demoDir, "sessions.jsonl"),
		demo.demoPastSessions(start).map((summary) => `${JSON.stringify(summary)}\n`).join(""),
	);
	const workspace = demo.demoWorkspace(start);
	workspaces = { list: () => [workspace], addFolder() {} };
	history = createHistory({ dataDir: demoDir, workspaces, pricing });
	// The demo names its servers from the known names alone, whatever this machine configures.
	mcpNames = createMcpNames({ configs: false });
	for (const envelope of demo.demoEnvelopes(start)) {
		setTimeout(() => publish(envelope), Math.max(0, envelope.time - start));
	}
} else {
	workspaces = createWorkspaceRegistry({ dataDir: dir, extraFolders: args.workspace });
	history = createHistory({ dataDir: dir, workspaces, pricing });
	mcpNames = createMcpNames({ folders: () => workspaces.list().map((workspace) => workspace.path) });
	const { recorded, published } = loadRecorded(Number(args.days), Number(args.retention));
	console.log(
		`[agent-monitor] Loaded ${published} event(s) for the page and ${recorded} for the history from ${dir}; ${workspaces.list().length} workspace(s) found.`,
	);
	tailDayFile(dir, "hooks", onHookRecord);
	listen(handleOtlp, otlpPort, "otlp");
}

listen(handleUi, uiPort, "ui");
console.log(`[agent-monitor] UI:   http://localhost:${uiPort}`);
if (!args.demo) console.log(`[agent-monitor] OTLP: http://localhost:${otlpPort} (http/json)`);
