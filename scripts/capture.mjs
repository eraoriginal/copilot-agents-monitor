#!/usr/bin/env node
/**
 * The README's screenshots and GIFs, taken from the `--demo` run in a headless Chrome or Edge
 * driven over the DevTools protocol. GIFs need ffmpeg on the PATH.
 *
 *   node scripts/capture.mjs [--out docs/media] [--port 4391] [--browser <path to chrome>]
 *
 * It starts a demo of its own on a spare port, so it never touches a monitor already running, and
 * takes about three minutes: the demo plays in real time.
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { values: args } = parseArgs({
	options: {
		out: { type: "string", default: "docs/media" },
		port: { type: "string", default: "4391" },
		browser: { type: "string" },
	},
});
const OUT = resolve(ROOT, args.out);
const URL_UNDER_TEST = `http://localhost:${args.port}/`;
const VIEWPORT = { width: 1440, height: 900 };
const BROWSERS = [
	args.browser,
	process.env.CHROME_PATH,
	"C:/Program Files/Google/Chrome/Application/chrome.exe",
	"C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
];

// The demo and the browser this script started, and the browser's throwaway profile.
const children = [];
const folders = [];
process.on("exit", () => children.forEach((child) => child.kill()));
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(1));

/** Stops what the script started, and removes the profile once the browser has let go of it. */
async function shutdown() {
	for (const child of children.reverse()) {
		if (child.exitCode !== null || child.signalCode !== null) continue;
		const exited = new Promise((resolve) => child.once("exit", resolve));
		child.kill();
		await Promise.race([exited, sleep(5000)]);
	}
	for (const folder of folders) rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}

function log(message) {
	console.log(`[capture] ${message}`);
}

async function until(check, { timeout = 30_000, every = 250, what = "a condition" } = {}) {
	const deadline = Date.now() + timeout;
	for (;;) {
		const value = await check().catch(() => null);
		if (value) return value;
		if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
		await sleep(every);
	}
}

// ---------------------------------------------------------------------------------------------
// The demo and the browser.

async function startDemo() {
	const server = spawn(process.execPath, ["src/server.js", "--demo", "--ui-port", args.port], { cwd: ROOT, stdio: "ignore" });
	children.push(server);
	await until(async () => (await fetch(`${URL_UNDER_TEST}api/status`)).ok, { what: "the demo server" });
	return Date.now();
}

async function startBrowser() {
	const executable = BROWSERS.find((candidate) => candidate && existsSync(candidate));
	if (!executable) throw new Error("no Chrome or Edge found: pass --browser <path>");
	const profile = mkdtempSync(join(tmpdir(), "capture-profile-"));
	const browser = spawn(
		executable,
		[
			"--headless=new",
			"--remote-debugging-port=0",
			`--user-data-dir=${profile}`,
			`--window-size=${VIEWPORT.width},${VIEWPORT.height}`,
			"--hide-scrollbars",
			"--no-first-run",
			"--no-default-browser-check",
			"about:blank",
		],
		{ stdio: "ignore" },
	);
	children.push(browser);
	folders.push(profile);
	// The browser writes the port it took, and the path of its endpoint, into its profile.
	const [port, path] = await until(
		async () => {
			const lines = readFileSync(join(profile, "DevToolsActivePort"), "utf8").trim().split("\n");
			return lines.length === 2 ? lines : null;
		},
		{ what: "the browser's DevTools endpoint" },
	);
	return connect(`ws://127.0.0.1:${port}${path}`);
}

/** A DevTools protocol client: `send(method, params, sessionId)` resolves with the result. */
function connect(url) {
	const socket = new WebSocket(url);
	const pending = new Map();
	let id = 0;
	socket.addEventListener("message", (event) => {
		const message = JSON.parse(event.data);
		const waiter = message.id ? pending.get(message.id) : null;
		if (!waiter) return;
		pending.delete(message.id);
		if (message.error) waiter.reject(new Error(`${waiter.method}: ${message.error.message}`));
		else waiter.resolve(message.result);
	});
	const send = (method, params = {}, sessionId = undefined) =>
		new Promise((resolve, reject) => {
			id += 1;
			pending.set(id, { resolve, reject, method });
			socket.send(JSON.stringify({ id, method, params, sessionId }));
		});
	return new Promise((resolve, reject) => {
		socket.addEventListener("open", () => resolve({ send }));
		socket.addEventListener("error", () => reject(new Error(`cannot reach ${url}`)));
	});
}

async function openPage(browser) {
	const { targetId } = await browser.send("Target.createTarget", { url: "about:blank" });
	const { sessionId } = await browser.send("Target.attachToTarget", { targetId, flatten: true });
	const send = (method, params) => browser.send(method, params, sessionId);
	await send("Page.enable");
	await send("Emulation.setDeviceMetricsOverride", { ...VIEWPORT, deviceScaleFactor: 1, mobile: false });
	await send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
	await send("Page.navigate", { url: URL_UNDER_TEST });

	const page = {
		send,
		mouse: { x: VIEWPORT.width / 2, y: VIEWPORT.height - 120 },
		async evaluate(expression) {
			const { result, exceptionDetails } = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
			if (exceptionDetails) throw new Error(exceptionDetails.exception?.description ?? exceptionDetails.text);
			return result.value;
		},
		/** Runs `fn` in the page; it sees nothing of this script but its JSON-able argument. */
		run(fn, arg) {
			return page.evaluate(`(${fn})(${JSON.stringify(arg ?? null)})`);
		},
		async screenshot(name, clip) {
			// A part of the page goes without the status line pinned to the bottom of the window.
			if (clip) await page.evaluate(`document.head.insertAdjacentHTML("beforeend", "<style id=capture-hide>.statusline { visibility: hidden }</style>")`);
			const { data } = await send("Page.captureScreenshot", { format: "png", ...(clip ? { clip: { ...clip, scale: 1 }, captureBeyondViewport: true } : {}) });
			if (clip) await page.evaluate(`document.getElementById("capture-hide").remove()`);
			writeFileSync(join(OUT, name), Buffer.from(data, "base64"));
			log(`${name} (${Math.round(statSync(join(OUT, name)).size / 1024)} kB)`);
		},
		/** Moves the pointer there, eased, as a hand would. */
		async move(to, ms = 650) {
			const from = page.mouse;
			const steps = Math.max(1, Math.round(ms / 16));
			for (let i = 1; i <= steps; i += 1) {
				const t = i / steps;
				const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
				const point = { x: from.x + (to.x - from.x) * eased, y: from.y + (to.y - from.y) * eased };
				await send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
				await sleep(16);
			}
			page.mouse = to;
		},
		async click(to) {
			await page.move(to);
			for (const type of ["mousePressed", "mouseReleased"]) {
				await send("Input.dispatchMouseEvent", { type, ...to, button: "left", clickCount: 1 });
			}
		},
	};
	return page;
}

// ---------------------------------------------------------------------------------------------
// GIFs: screenshots taken as fast as the browser gives them, timed, then encoded by ffmpeg.

async function recordGif(page, name, { clip, fps = 10, speed = 1, width = 960, during }) {
	const dir = mkdtempSync(join(tmpdir(), "capture-frames-"));
	const frames = [];
	let recording = true;
	const loop = (async () => {
		while (recording) {
			const at = performance.now();
			const { data } = await page.send("Page.captureScreenshot", { format: "jpeg", quality: 92, ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
			const file = join(dir, `${String(frames.length).padStart(5, "0")}.jpg`).replace(/\\/g, "/");
			writeFileSync(file, Buffer.from(data, "base64"));
			frames.push({ file, at });
			const wait = 1000 / fps - (performance.now() - at);
			if (wait > 0) await sleep(wait);
		}
	})();
	await during();
	recording = false;
	await loop;

	// Each frame lasts until the next one was taken: the GIF keeps the run's own pace.
	const list = ["ffconcat version 1.0"];
	frames.forEach((frame, index) => {
		const next = frames[index + 1]?.at ?? frame.at + 1000 / fps;
		list.push(`file '${frame.file}'`, `duration ${((next - frame.at) / 1000).toFixed(3)}`);
	});
	list.push(`file '${frames.at(-1).file}'`);
	writeFileSync(join(dir, "frames.txt"), list.join("\n"));
	const filters = [
		`setpts=PTS/${speed}`,
		`fps=${fps}`,
		`scale=${width}:-1:flags=lanczos`,
		"split[a][b];[a]palettegen=stats_mode=diff:max_colors=160[palette];[b][palette]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle",
	].join(",");
	const ffmpeg = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-f", "concat", "-safe", "0", "-i", join(dir, "frames.txt"), "-vf", filters, join(OUT, name)], {
		encoding: "utf8",
	});
	rmSync(dir, { recursive: true, force: true });
	if (ffmpeg.status !== 0) throw new Error(`ffmpeg: ${ffmpeg.stderr || ffmpeg.error?.message}`);
	log(`${name}: ${frames.length} frames (${Math.round(statSync(join(OUT, name)).size / 1024)} kB)`);
}

// ---------------------------------------------------------------------------------------------
// What runs in the page.

/** A pointer drawn into the page: a headless browser draws none, and a GIF needs one. */
function installCursor() {
	if (document.getElementById("capture-cursor")) return;
	const cursor = document.createElement("div");
	cursor.id = "capture-cursor";
	cursor.innerHTML =
		'<svg width="20" height="22" viewBox="0 0 20 22"><path d="M2 1 L2 17 L6.5 13 L9.5 20 L12.5 18.7 L9.6 12 L15.5 12 Z" fill="#fff" stroke="#111" stroke-width="1.4" stroke-linejoin="round"/></svg>';
	Object.assign(cursor.style, { position: "fixed", left: "0", top: "0", zIndex: "2147483647", pointerEvents: "none", transform: "translate(-50px, -50px)" });
	document.body.append(cursor);
	addEventListener("mousemove", (event) => (cursor.style.transform = `translate(${event.clientX - 2}px, ${event.clientY - 1}px)`), true);
}

/** The box of `selector` (or of its closest `up`), in page coordinates, padded, cut to `maxHeight`. */
function boxOf({ selector, up = null, maxHeight = Infinity, pad = 0 }) {
	const found = document.querySelector(selector);
	const element = up ? found?.closest(up) : found;
	if (!element) return null;
	const box = element.getBoundingClientRect();
	return {
		x: Math.max(0, box.left - pad),
		y: Math.max(0, box.top + scrollY - pad),
		width: Math.min(innerWidth, box.width + 2 * pad),
		height: Math.min(maxHeight, box.height + 2 * pad),
	};
}

/** Where a line runs, in viewport coordinates: `at` pixels from its start, or from its end if negative. */
function pointOnLine({ kind, label, at }) {
	const path = [...document.querySelectorAll(`.links-hit .hit[data-kind="${kind}"]`)].find((hit) => hit.dataset.label.includes(label));
	if (!path) return null;
	const length = path.getTotalLength();
	const point = path.getPointAtLength(at >= 0 ? at : length + at);
	const matrix = path.getScreenCTM();
	return { x: matrix.a * point.x + matrix.e, y: matrix.d * point.y + matrix.f };
}

function centreOf(selector) {
	const box = document.querySelector(selector)?.getBoundingClientRect();
	return box ? { x: box.left + box.width / 2, y: box.top + box.height / 2 } : null;
}

// ---------------------------------------------------------------------------------------------

/** The run, from the scouts at work to the end, and what the README shows of it. */
async function capture() {
	const startedAt = await startDemo();
	log(`demo on ${URL_UNDER_TEST}`);
	const browser = await startBrowser();
	const page = await openPage(browser);
	// The scouts' first calls: the run has begun, the conductor is named.
	await until(() => page.evaluate(`document.querySelectorAll(".card").length > 1`), { what: "the first subagent" });
	const since = () => (Date.now() - startedAt) / 1000;

	// The run, live: from the scouts at work to the designers, a little faster than life.
	await recordGif(page, "live.gif", {
		fps: 6,
		speed: 1.5,
		width: 900,
		during: async () => {
			await until(async () => since() > 38, { timeout: 60_000, what: "the middle of the run" });
			await page.screenshot("overview.png");
			await until(async () => since() > 46, { timeout: 60_000, what: "the designers" });
		},
	});

	log("waiting for the run to end");
	await until(() => page.evaluate(`document.title === "Agent Monitor" && document.querySelectorAll(".card.running").length === 0`), {
		timeout: 180_000,
		every: 1000,
		what: "the end of the run",
	});
	await sleep(4000);
	await page.run(installCursor);
	await page.evaluate("scrollTo(0, 0)");

	// An agent's tool calls, MCP first: the scout that read the ticket through Atlassian.
	await page.evaluate(`[...document.querySelectorAll(".card")].find((card) => card.textContent.includes("scout") && card.querySelector(".card-mcp")?.textContent.includes("atlassian")).click()`);
	await sleep(600);
	await page.evaluate(`document.querySelector(".tool-call.mcp").open = true`);
	await sleep(600);
	await page.screenshot("tool-calls.png", await page.run(boxOf, { selector: "#app .grid", maxHeight: 720 }));
	await page.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
	await sleep(500);

	// The messages on the lines: the stretch every launch shares, then one branch, then an answer.
	const area = await page.run(boxOf, { selector: "#app .grid", maxHeight: 640 });
	await recordGif(page, "messages.gif", {
		clip: area,
		fps: 12,
		during: async () => {
			await sleep(600);
			await page.move(await page.run(pointOnLine, { kind: "launch", label: "→ scout #1", at: 8 }), 900);
			await sleep(1400);
			await page.click(page.mouse);
			await sleep(2200);
			await page.evaluate(`document.getElementById("message-body").scrollBy({ top: 360, behavior: "smooth" })`);
			await sleep(1600);
			// The branch into the card is short: low on it, away from the stretch the others share.
			await page.move(await page.run(pointOnLine, { kind: "launch", label: "→ scout #1", at: -2 }), 900);
			await sleep(700);
			await page.click(page.mouse);
			await sleep(2200);
			await page.click(await page.run(centreOf, '#message-panel [data-direction="ret"]'));
			await sleep(2600);
		},
	});
	await page.evaluate(`document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }))`);
	await page.move({ x: VIEWPORT.width - 10, y: VIEWPORT.height - 10 }, 200);
	await sleep(500);

	// The session's MCP servers, and the history of past tickets.
	await page.screenshot("mcp.png", await page.run(boxOf, { selector: "#mcp", up: ".panel", pad: 8 }));
	await page.evaluate(`document.querySelector('[data-view="history"]').click()`);
	await until(() => page.evaluate(`document.querySelectorAll("#history-tickets tr").length > 1`), { what: "the history" });
	await sleep(1200);
	await page.screenshot("history.png");
	log(`done in ${Math.round(since())}s, in ${OUT}`);
}

mkdirSync(OUT, { recursive: true });
try {
	await capture();
} finally {
	await shutdown();
}
