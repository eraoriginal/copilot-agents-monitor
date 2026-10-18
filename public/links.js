/**
 * The lines between agents, drawn in one SVG laid under the cards. Positions come from the cards'
 * layout boxes (offsets, which ignore the transforms of their entrance animations); the routes
 * come from `routes.js`. Paths persist from one update to the next, keyed by agent, so that a
 * running animation is not restarted each time the page redraws.
 *
 *   launch   parent → child: a solid line, an arrowhead on the child's card.
 *   run      the same route in dashes that advance toward the child, while the child works.
 *   return   child → parent: dashes out of the child's card, an arrowhead in the parent's foot;
 *            faint until the child is done, green after, advancing for a few seconds at the end.
 *            When a later run of the parent was started to read the answer, the line runs on down
 *            to the top of that run's card instead.
 *
 * A second SVG, over the cards, holds a wide invisible stroke along each launch and return: what
 * the pointer and the keyboard reach. It stops short of the cards, so a card stays clickable.
 * Lines overlap where they share a stretch, so what lies under the pointer is found from the
 * routes themselves: every line that runs there, not only the one drawn on top.
 */

import { distanceTo, pathData, routesFor, trim } from "./routes.js";

const NS = "http://www.w3.org/2000/svg";
const DASH = 6;
const GAP = 4;
const PERIOD = DASH + GAP;
/** Every animated line runs on one clock, so dashes on a shared stretch overlap exactly. */
const CLOCK_MS = 800;
const RETURN_ADVANCE_MS = 4000;
const TONES = ["idle", "run", "warn", "done", "fail"];
/** How close to a line the pointer must be to be on it: half the width of the stroke it reaches. */
const REACH = 5;

const markers = TONES.map(
	(tone) => `<marker id="arrow-${tone}" class="tone-${tone}" viewBox="0 0 10 10" refX="9.5" refY="5" markerWidth="9" markerHeight="9" markerUnits="userSpaceOnUse" orient="auto"><path d="M0.5 1.2 L9.5 5 L0.5 8.8 Z"/></marker><marker id="dot-${tone}" class="tone-${tone}" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="7" markerHeight="7" markerUnits="userSpaceOnUse"><circle cx="5" cy="5" r="4.5"/></marker>`,
).join("");

/** An element's box in the coordinates of `flow`'s content, from layout offsets. */
function boxOf(flow, element) {
	let left = 0;
	let top = 0;
	for (let node = element; node && node !== flow; node = node.offsetParent) {
		left += node.offsetLeft;
		top += node.offsetTop;
	}
	const width = element.offsetWidth;
	const height = element.offsetHeight;
	return { left, top, right: left + width, bottom: top + height, width, height, cx: left + width / 2, cy: top + height / 2 };
}

const clock = () => document.timeline.currentTime ?? performance.now();

export function createLinkLayer(flow) {
	const svg = document.createElementNS(NS, "svg");
	svg.setAttribute("class", "links");
	svg.setAttribute("aria-hidden", "true");
	svg.innerHTML = `<defs>${markers}</defs>`;
	const groups = {};
	for (const name of ["launch", "pending", "done", "run"]) {
		groups[name] = document.createElementNS(NS, "g");
		groups[name].setAttribute("class", `layer-${name}`);
		svg.append(groups[name]);
	}
	flow.prepend(svg);

	const hitLayer = document.createElementNS(NS, "svg");
	hitLayer.setAttribute("class", "links-hit");
	flow.append(hitLayer);

	const paths = new Map();
	const hits = new Map();
	let routes = new Map();
	let lastOptions = {};

	/** The path for `id` in `group`, created if needed; moved if it changed group. */
	function pathIn(id, group, className) {
		let path = paths.get(id);
		if (!path) {
			path = document.createElementNS(NS, "path");
			// Which line this is, for anyone inspecting the page.
			path.dataset.kind = { L: "launch", U: "run", R: "ret" }[id[0]];
			path.dataset.key = id.slice(2);
			paths.set(id, path);
		}
		if (path.parentNode !== groups[group]) {
			groups[group].append(path);
			path._animated = false;
		}
		if (path.getAttribute("class") !== className) path.setAttribute("class", className);
		return path;
	}

	function draw(path, points, anchor) {
		const d = pathData(points);
		if (path.getAttribute("d") !== d) path.setAttribute("d", d);
		let offset = 0;
		if (anchor === "end") {
			// Dashes counted back from the end of the line: lines that end alike overlap on their last stretch.
			const length = path.getTotalLength();
			offset = (((DASH - length) % PERIOD) + PERIOD) % PERIOD;
		}
		const value = `${Math.round(offset * 100) / 100}px`;
		if (path.style.getPropertyValue("--off") !== value) path.style.setProperty("--off", value);
	}

	/** The wide stroke the pointer and the keyboard reach along line `id` ("L:key" or "R:key"). */
	function hitFor(id, points, label, selected) {
		let path = hits.get(id);
		if (!path) {
			path = document.createElementNS(NS, "path");
			path.setAttribute("class", "hit");
			path.setAttribute("tabindex", "0");
			path.setAttribute("role", "button");
			path.dataset.kind = id[0] === "L" ? "launch" : "ret";
			path.dataset.key = id.slice(2);
			hitLayer.append(path);
			hits.set(id, path);
		}
		const d = pathData(trim(points, REACH));
		if (path.getAttribute("d") !== d) path.setAttribute("d", d);
		path.classList.toggle("selected", selected);
		path.setAttribute("aria-pressed", String(selected));
		if (path.dataset.label !== label) {
			path.dataset.label = label;
			path.setAttribute("aria-label", label.replace(/\n/g, ". "));
		}
	}

	/** Starts or stops the advance; a starting line joins the shared clock. */
	function advance(path, on) {
		if (on && !path._animated) path.style.animationDelay = `-${Math.round(clock() % CLOCK_MS)}ms`;
		path._animated = on;
	}

	function remove(id) {
		paths.get(id)?.remove();
		paths.delete(id);
		hits.get(id)?.remove();
		hits.delete(id);
	}

	function statusOf(card) {
		return ["running", "stalled", "failed", "done"].find((status) => card.classList.contains(status)) ?? "running";
	}

	return {
		/**
		 * Measures the cards, draws every line, and returns key → `{ launch, ret }` (points).
		 * `selected` holds the lines shown as chosen ("L:key" or "R:key"); `describe(kind, key)`
		 * names a line for the keyboard.
		 */
		update(options = lastOptions) {
			lastOptions = options;
			const { selected = [], describe = () => "" } = options;
			const chosen = new Set(selected);
			routes = new Map();
			const live = new Set();
			const now = performance.now();
			const cardsByKey = new Map([...flow.querySelectorAll(".card")].map((card) => [card.dataset.key, card]));
			for (const node of flow.querySelectorAll(".node")) {
				const parentCard = node.querySelector(":scope > .slot > .card");
				const kids = node.querySelector(":scope > .kids");
				if (!parentCard || !kids || kids.hidden) continue;
				const cards = new Map();
				const cells = [];
				// A child whose answer is read by a later run of the parent: that run's card, below.
				const readers = new Map();
				for (const cell of kids.querySelectorAll(":scope > .wave > .cell")) {
					const card = cell.querySelector(":scope > .node > .slot > .card");
					if (!card) continue;
					cards.set(card.dataset.key, card);
					cells.push({ key: card.dataset.key, ...boxOf(flow, cell), card: boxOf(flow, card) });
					const reader = card.dataset.returnTo ? cardsByKey.get(card.dataset.returnTo) : null;
					if (reader) readers.set(card.dataset.key, boxOf(flow, reader));
				}
				for (const [key, route] of routesFor({ parent: boxOf(flow, parentCard), kids: boxOf(flow, kids), cells, readers })) {
					routes.set(key, route);
					const card = cards.get(key);
					const status = statusOf(card);
					const working = status === "running" || status === "stalled";
					const mark = (id) => (chosen.has(id) ? " selected" : "");

					draw(pathIn(`L:${key}`, "launch", `launch${mark(`L:${key}`)}`), route.launch, "start");
					hitFor(`L:${key}`, route.launch, describe("launch", key), chosen.has(`L:${key}`));
					live.add(`L:${key}`);

					if (working) {
						const run = pathIn(`U:${key}`, "run", status === "stalled" ? "run stalled" : "run");
						draw(run, route.launch, "start");
						advance(run, status === "running");
						live.add(`U:${key}`);
					}

					const state = status === "done" ? "done" : status === "failed" ? "failed" : "pending";
					const returning = state === "done" && card._doneAt != null && now - card._doneAt < RETURN_ADVANCE_MS;
					const ret = pathIn(`R:${key}`, state === "pending" ? "pending" : "done", `ret ${state}${returning ? " returning" : ""}${mark(`R:${key}`)}`);
					draw(ret, route.ret, "end");
					advance(ret, returning);
					hitFor(`R:${key}`, route.ret, describe("ret", key), chosen.has(`R:${key}`));
					live.add(`R:${key}`);
				}
			}
			for (const id of new Set([...paths.keys(), ...hits.keys()])) if (!live.has(id)) remove(id);
			return routes;
		},

		/**
		 * Every line under a point of the screen, as `{ kind, keys }`: a stretch that lines share
		 * gives all of them, a branch only its own. Launches and returns never share a stretch.
		 */
		linesAt(clientX, clientY) {
			const matrix = hitLayer.getScreenCTM();
			if (!matrix) return null;
			const point = new DOMPoint(clientX, clientY).matrixTransform(matrix.inverse());
			let best = null;
			for (const kind of ["launch", "ret"]) {
				const keys = [];
				let nearest = Number.POSITIVE_INFINITY;
				for (const [key, route] of routes) {
					const distance = distanceTo(route[kind], point);
					if (distance <= REACH) keys.push(key);
					nearest = Math.min(nearest, distance);
				}
				if (keys.length > 0 && (!best || nearest < best.nearest)) best = { kind, keys, nearest };
			}
			return best && { kind: best.kind, keys: best.keys };
		},

		/** Lights up the lines the pointer is on, all of them along a shared stretch. */
		hover(lines) {
			const on = new Set(lines ? lines.keys.map((key) => `${lines.kind === "ret" ? "R" : "L"}:${key}`) : []);
			for (const [id, path] of hits) path.classList.toggle("hover", on.has(id));
		},

		clear() {
			for (const id of new Set([...paths.keys(), ...hits.keys()])) remove(id);
			routes = new Map();
		},
	};
}
