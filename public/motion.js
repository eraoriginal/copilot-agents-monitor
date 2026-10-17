/**
 * Motion for the page: elements that persist from one render to the next, so transitions can
 * run; numbers that count to their new value; packets that travel along a connector when an
 * agent delegates or reports back. Everything stands still under `prefers-reduced-motion`.
 */

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");

export const motionAllowed = () => !reducedMotion.matches;

/**
 * Keeps one element per key in `container`, in the order of `items`: an existing element is
 * updated in place, a new one created, one whose key is gone removed. Returns the new ones.
 */
export function reconcile(container, items, keyOf, create, update) {
	const existing = new Map();
	for (const child of container.children) {
		if (child.dataset.key != null) existing.set(child.dataset.key, child);
	}
	const keep = new Set();
	const created = [];
	let previous = null;
	for (const item of items) {
		const key = String(keyOf(item));
		keep.add(key);
		let node = existing.get(key);
		const isNew = !node;
		if (isNew) {
			node = create(item);
			node.dataset.key = key;
			created.push(node);
		}
		update(node, item, isNew);
		const expected = previous ? previous.nextSibling : container.firstChild;
		if (node !== expected) container.insertBefore(node, expected);
		previous = node;
	}
	for (const child of [...container.children]) {
		if (child.dataset.key == null || !keep.has(child.dataset.key)) child.remove();
	}
	return created;
}

const easeOut = (t) => 1 - (1 - t) ** 3;

/** Sets a number's text, counting from the value it showed to the new one. */
export function countTo(node, value, format, duration = 650) {
	const from = node._value;
	node._value = value;
	cancelAnimationFrame(node._frame);
	if (from == null || !motionAllowed() || !Number.isFinite(value) || from === value) {
		node.textContent = format(value);
		return;
	}
	const start = performance.now();
	const step = (now) => {
		const t = Math.min(1, (now - start) / duration);
		node.textContent = format(from + (value - from) * easeOut(t));
		if (t < 1) node._frame = requestAnimationFrame(step);
	};
	node._frame = requestAnimationFrame(step);
}

/** Plays a one-shot CSS animation class, and removes it when it ends. */
export function flash(node, className) {
	if (!motionAllowed()) return;
	node.classList.remove(className);
	void node.offsetWidth;
	node.classList.add(className);
	node.addEventListener("animationend", () => node.classList.remove(className), { once: true });
}

/**
 * Sends a labeled packet from one element to another inside `layer`, along the connector: down
 * from the source, across at `viaY`, down into the target. `up` sends it back the other way.
 */
export function sendPacket(layer, from, to, { label, tone = "accent", viaY = null, up = false, duration = 1100 }) {
	if (!motionAllowed() || !from.isConnected || !to.isConnected) return;
	const base = layer.getBoundingClientRect();
	const a = from.getBoundingClientRect();
	const b = to.getBoundingClientRect();
	const top = { x: a.left + a.width / 2 - base.left, y: a.bottom - base.top };
	const bottom = { x: b.left + b.width / 2 - base.left, y: b.top - base.top };
	const middle = viaY == null ? (top.y + bottom.y) / 2 : viaY - base.top;
	let points = [top, { x: top.x, y: middle }, { x: bottom.x, y: middle }, bottom];
	if (up) points = points.reverse();
	const lengths = points.slice(1).map((point, i) => Math.hypot(point.x - points[i].x, point.y - points[i].y));
	const total = lengths.reduce((sum, length) => sum + length, 0) || 1;
	let travelled = 0;
	const frames = points.map((point, i) => {
		if (i > 0) travelled += lengths[i - 1];
		return { transform: `translate(${point.x}px, ${point.y}px) translate(-50%, -50%)`, offset: travelled / total };
	});
	const packet = document.createElement("span");
	packet.className = `packet ${tone}`;
	packet.textContent = label;
	layer.append(packet);
	const animation = packet.animate(frames, { duration, easing: "cubic-bezier(.45,.05,.35,1)" });
	animation.onfinish = () => packet.remove();
	animation.oncancel = () => packet.remove();
}

/** Types `text` into `node`, a character at a time; a new call replaces the one running. */
export function typeInto(node, text, { perChar = 18, maxMs = 900 } = {}) {
	clearInterval(node._typing);
	if (!motionAllowed() || node.textContent === text) {
		node.textContent = text;
		return;
	}
	const step = Math.max(1, Math.ceil(text.length / (maxMs / perChar)));
	let shown = 0;
	node.textContent = "";
	node._typing = setInterval(() => {
		shown = Math.min(text.length, shown + step);
		node.textContent = text.slice(0, shown);
		if (shown >= text.length) clearInterval(node._typing);
	}, perChar);
}
