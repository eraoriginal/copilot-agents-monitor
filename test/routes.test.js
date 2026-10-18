import assert from "node:assert/strict";
import { test } from "node:test";
import { distanceTo, lengthOf, pathData, routesFor, rowsOf, SPACING, tidy, trim } from "../public/routes.js";

/** A box with the centre and edges every consumer reads. */
function box(left, top, width, height) {
	return { left, top, right: left + width, bottom: top + height, cx: left + width / 2, cy: top + height / 2 };
}

/** A cell holding only a card of the same size. */
function leaf(key, left, top, width = 200, height = 100) {
	const card = box(left, top, width, height);
	return { key, ...card, card };
}

/** The demo's shape: a parent above a wave of three, a wave of two, and a lone agent. */
function layout() {
	const parent = box(200, 0, 380, 100);
	const kids = { left: 0, right: 780 };
	const cells = [
		leaf("a", 30, 156),
		leaf("b", 248, 156),
		leaf("c", 466, 156),
		leaf("d", 139, 320),
		leaf("e", 357, 320),
		leaf("f", 248, 484),
	];
	return { parent, kids, cells };
}

const segments = (points) => points.slice(1).map((point, i) => [points[i], point]);

function crosses([a, b], rect) {
	const inset = 0.5;
	const left = rect.left + inset;
	const right = rect.right - inset;
	const top = rect.top + inset;
	const bottom = rect.bottom - inset;
	if (a.x === b.x) {
		return a.x > left && a.x < right && Math.max(a.y, b.y) > top && Math.min(a.y, b.y) < bottom;
	}
	return a.y > top && a.y < bottom && Math.max(a.x, b.x) > left && Math.min(a.x, b.x) < right;
}

test("every line is made of horizontal and vertical segments only", () => {
	for (const { launch, ret } of routesFor(layout()).values()) {
		for (const points of [launch, ret]) {
			for (const [a, b] of segments(points)) assert.ok(a.x === b.x || a.y === b.y, JSON.stringify([a, b]));
		}
	}
});

test("a launch leaves the parent's left port and ends on the top edge of its card, pointing down", () => {
	const { parent, kids, cells } = layout();
	const routes = routesFor({ parent, kids, cells });
	for (const cell of cells) {
		const { launch } = routes.get(cell.key);
		assert.deepEqual(launch[0], { x: parent.cx - SPACING.port, y: parent.bottom });
		assert.deepEqual(launch.at(-1), { x: cell.card.cx, y: cell.card.top });
		const [before, end] = launch.slice(-2);
		assert.equal(before.x, end.x);
		assert.ok(before.y < end.y, "the last segment goes down");
	}
});

test("a return leaves the right edge of its card and ends on the parent's foot, pointing up", () => {
	const { parent, kids, cells } = layout();
	const routes = routesFor({ parent, kids, cells });
	for (const cell of cells) {
		const { ret } = routes.get(cell.key);
		assert.deepEqual(ret[0], { x: cell.card.right, y: cell.card.cy });
		assert.deepEqual(ret.at(-1), { x: parent.cx + SPACING.port, y: parent.bottom });
		const [before, end] = ret.slice(-2);
		assert.equal(before.x, end.x);
		assert.ok(before.y > end.y, "the last segment goes up");
	}
});

test("a return read by a card below the block runs on down the right rail into that card's top", () => {
	const { parent, kids, cells } = layout();
	// The reader lies below the last row (it ends at 584), with room for the stem between.
	const reader = box(200, 660, 380, 100);
	const readers = new Map([["a", reader], ["f", reader]]);
	const routes = routesFor({ parent, kids, cells, readers });
	const railRight = kids.right - SPACING.rail;
	for (const key of ["a", "f"]) {
		const { ret } = routes.get(key);
		assert.deepEqual(ret.at(-1), { x: reader.cx + SPACING.port, y: reader.top });
		const [before, end] = ret.slice(-2);
		assert.equal(before.x, end.x);
		assert.ok(before.y < end.y, "the last segment goes down");
		assert.ok(ret.some((point) => point.x === railRight && point.y === reader.top - SPACING.stem), "down the right rail");
		for (const segment of segments(ret)) {
			for (const card of [parent, reader, ...cells.map((cell) => cell.card)]) assert.equal(crosses(segment, card), false);
		}
	}
	// A child without a reader below still comes back up into the parent's foot.
	assert.deepEqual(routes.get("b").ret.at(-1), { x: parent.cx + SPACING.port, y: parent.bottom });
	// A reader that does not lie below the bus is not reached by going down.
	const level = routesFor({ parent, kids, cells, readers: new Map([["f", box(200, 500, 380, 100)]]) });
	assert.deepEqual(level.get("f").ret.at(-1), { x: parent.cx + SPACING.port, y: parent.bottom });
});

test("no line passes through a card", () => {
	const { parent, kids, cells } = layout();
	const cards = [parent, ...cells.map((cell) => cell.card)];
	for (const [key, { launch, ret }] of routesFor({ parent, kids, cells })) {
		for (const points of [launch, ret]) {
			for (const segment of segments(points)) {
				for (const card of cards) assert.equal(crosses(segment, card), false, `${key}: ${JSON.stringify(segment)}`);
			}
		}
	}
});

test("launches use the left side and returns the right: the two never share a stretch", () => {
	const { parent, kids, cells } = layout();
	const routes = routesFor({ parent, kids, cells });
	const railLeft = kids.left + SPACING.rail;
	const railRight = kids.right - SPACING.rail;
	for (const { launch, ret } of routes.values()) {
		// A launch never reaches the right rail; a return never reaches the left one.
		assert.ok(launch.every((point) => point.x < railRight), "a launch stays left of the right rail");
		assert.ok(launch.every((point) => point.x >= railLeft));
		assert.ok(ret.every((point) => point.x > railLeft), "a return stays right of the left rail");
		assert.ok(ret.some((point) => point.x === railRight));
	}
	const lower = routes.get("f");
	assert.ok(lower.launch.some((point) => point.x === railLeft), "a lower row is reached down the left rail");
	assert.ok(routes.get("a").launch.every((point) => point.x !== railLeft), "the first row needs no rail");
});

test("a card with agents of its own: its return leaves its edge, beside its subtree", () => {
	// The middle child launched agents itself: its cell is wide and tall, its card centred and narrow.
	const parent = box(200, 0, 380, 100);
	const kids = { left: 0, right: 780 };
	const card = box(200, 156, 380, 100);
	const nestedCards = [box(60, 340, 200, 100), box(280, 340, 200, 100)];
	const cell = { key: "mid", left: 30, right: 750, top: 156, bottom: 520, card };
	const routes = routesFor({ parent, kids, cells: [cell] });
	const { launch, ret } = routes.get("mid");
	assert.deepEqual(launch.at(-1), { x: card.cx, y: card.top });
	assert.equal(ret[0].x, card.right);
	assert.ok(ret.some((point) => point.x === cell.right + SPACING.lane), "the lane is outside the cell");
	for (const points of [launch, ret]) {
		for (const segment of segments(points)) {
			for (const obstacle of [parent, card, ...nestedCards]) assert.equal(crosses(segment, obstacle), false);
		}
	}
});

test("cells that share a top form a row, and rows come back from top to bottom", () => {
	const rows = rowsOf([leaf("x", 0, 300), leaf("y", 0, 100), leaf("z", 220, 101)]);
	assert.deepEqual(rows.map((row) => row.cells.map((cell) => cell.key)), [["y", "z"], ["x"]]);
	assert.equal(rows[0].bottom, 201);
});

test("tidy drops repeated points and the middle of a straight run", () => {
	const points = tidy([{ x: 0, y: 0 }, { x: 0, y: 0 }, { x: 0, y: 5 }, { x: 0, y: 10 }, { x: 8, y: 10 }]);
	assert.deepEqual(points, [{ x: 0, y: 0 }, { x: 0, y: 10 }, { x: 8, y: 10 }]);
	assert.equal(lengthOf(points), 18);
});

test("a path rounds its corners and ends exactly where the line ends", () => {
	const d = pathData([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 40, y: 40 }]);
	assert.match(d, /^M0 0 L0 33 Q0 40 7 40 L40 40$/);
	// Two corners too close for the full radius: the radius shrinks to fit.
	assert.match(pathData([{ x: 0, y: 0 }, { x: 0, y: 6 }, { x: 20, y: 6 }]), /L0 3 Q0 6 3 6/);
});

test("trim shortens a line at both ends, and leaves a short one as it is", () => {
	assert.deepEqual(trim([{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 40, y: 40 }], 4), [{ x: 0, y: 4 }, { x: 0, y: 40 }, { x: 36, y: 40 }]);
	const short = [{ x: 0, y: 0 }, { x: 0, y: 10 }];
	assert.equal(trim(short, 4), short);
});

test("a point's distance to a line is its distance to the nearest segment", () => {
	const line = [{ x: 0, y: 0 }, { x: 0, y: 40 }, { x: 40, y: 40 }];
	assert.equal(distanceTo(line, { x: 3, y: 20 }), 3);
	assert.equal(distanceTo(line, { x: 20, y: 44 }), 4);
	assert.equal(distanceTo(line, { x: 0, y: -5 }), 5);
});

test("a point on a stretch that lines share is on every one of them; one on a branch is on its line only", () => {
	const { parent, kids, cells } = layout();
	const routes = routesFor({ parent, kids, cells });
	const near = (kind, point) => [...routes].filter(([, route]) => distanceTo(route[kind], point) < 5).map(([key]) => key).sort();
	const all = cells.map((cell) => cell.key).sort();
	// Out of the parent's foot, every launch runs down the same port; every return comes up another.
	assert.deepEqual(near("launch", { x: parent.cx - SPACING.port, y: parent.bottom + 6 }), all);
	assert.deepEqual(near("ret", { x: parent.cx + SPACING.port, y: parent.bottom + 6 }), all);
	// Down the left rail, only the launches into the lower rows.
	assert.deepEqual(near("launch", { x: kids.left + SPACING.rail, y: 300 }), ["d", "e", "f"]);
	// The last stretch into a card, and the lane beside it, belong to that card's agent alone.
	const a = cells[0];
	assert.deepEqual(near("launch", { x: a.card.cx, y: a.card.top - 8 }), ["a"]);
	assert.deepEqual(near("ret", { x: a.right + SPACING.lane, y: a.card.cy + 10 }), ["a"]);
	// A point on a return is never taken for a launch.
	for (const { ret } of routes.values()) {
		for (const [from, to] of segments(ret)) {
			const middle = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
			assert.deepEqual(near("launch", middle), []);
		}
	}
});
