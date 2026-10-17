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
 * Sends a labeled packet along `points`, in the coordinates of the layer's content, from the first
 * point to the last. The layer must be positioned: the packet is drawn inside it.
 */
export function sendPacket(layer, points, { label, tone = "accent", duration = 1100 }) {
	if (!motionAllowed() || points.length < 2) return;
	const lengths = points.slice(1).map((point, i) => Math.hypot(point.x - points[i].x, point.y - points[i].y));
	const total = lengths.reduce((sum, length) => sum + length, 0) || 1;
	let travelled = 0;
	const frames = points.map((point, i) => {
		if (i > 0) travelled += lengths[i - 1];
		return { transform: `translate(${point.x}px, ${point.y}px)`, offset: travelled / total };
	});
	const packet = document.createElement("span");
	packet.className = `packet ${tone}`;
	const text = document.createElement("b");
	text.textContent = label;
	packet.append(document.createElement("i"), text);
	layer.append(packet);
	// The dot rides the line; its label goes to whichever side of the route has the room, so that
	// it never sticks out of the layer.
	const xs = points.map((point) => point.x);
	const needed = text.offsetWidth + 14;
	const roomRight = layer.clientWidth - Math.max(...xs);
	const roomLeft = Math.min(...xs);
	packet.dataset.side = roomRight >= needed || roomRight >= roomLeft ? "right" : "left";
	// A long route takes longer: the packet keeps a readable speed.
	const animation = packet.animate(frames, { duration: Math.max(duration, total * 2.2), easing: "cubic-bezier(.45,.05,.35,1)" });
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
