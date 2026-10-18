/**
 * Where the links of one parent run, as plain geometry: no DOM, no Node. Boxes are given in one
 * coordinate system, y growing downward.
 *
 * A parent sits above the agents it launched, which are laid out in rows. Between them:
 *
 *   launch  one line per child, out of the parent's bottom-left port, down the left rail, along a
 *           bus above the child's row, and down into the top of the child's card.
 *   return  one line per child, out of the right edge of its card, down a lane beside it, along a
 *           bus below its row, up the right rail, and into the parent's bottom-right port.
 *
 * Launches only ever use the left side and above rows, returns the right side and below rows, so
 * no line crosses a card or another line's direction. Each line is its own path: where lines share
 * a stretch they overlap exactly.
 */

export const SPACING = {
	rail: 10, // from the edge of the children block to the rail
	lane: 9, // from a cell's right edge to its return lane
	bus: 18, // from a row's edge to the bus above or below it
	port: 14, // from the parent's centre to its launch and return ports
	stem: 14, // from the parent's foot to where a return turns toward its port
};

const near = (a, b, tolerance = 3) => Math.abs(a - b) < tolerance;

/** Cells that share a top form a row; rows come back from top to bottom. */
export function rowsOf(cells) {
	const rows = [];
	for (const cell of cells) {
		let row = rows.find((candidate) => near(candidate.top, cell.top));
		if (!row) {
			row = { top: cell.top, bottom: cell.bottom, cells: [] };
			rows.push(row);
		}
		row.cells.push(cell);
		row.bottom = Math.max(row.bottom, cell.bottom);
	}
	return rows.sort((a, b) => a.top - b.top);
}

/** Drops repeated points and the middle point of a straight run. */
export function tidy(points) {
	const out = [];
	for (const point of points) {
		const last = out.at(-1);
		if (last && near(last.x, point.x, 0.01) && near(last.y, point.y, 0.01)) continue;
		out.push(point);
	}
	return out.filter((point, i) => {
		if (i === 0 || i === out.length - 1) return true;
		const a = out[i - 1];
		const b = out[i + 1];
		const straightX = near(a.x, point.x, 0.01) && near(point.x, b.x, 0.01);
		const straightY = near(a.y, point.y, 0.01) && near(point.y, b.y, 0.01);
		return !(straightX || straightY);
	});
}

/**
 * `parent`: the parent's card. `kids`: the block holding its children, rails and lanes included.
 * `cells`: each child's cell, `{ key, left, right, top, bottom, card }`, where `card` is the
 * child's own card (a cell holds the card and, below it, the child's own children).
 * `readers`: for a child whose answer is read by another card below the block, that card's box
 * (a run of the parent started to read it): the return goes on down the right rail and into the
 * top of that card. Returns key → `{ launch, ret }`, each a list of points.
 */
export function routesFor({ parent, kids, cells, readers = new Map() }, spacing = SPACING) {
	const routes = new Map();
	if (cells.length === 0) return routes;
	const rows = rowsOf(cells);
	const portOut = parent.cx - spacing.port;
	const portIn = parent.cx + spacing.port;
	const railLeft = kids.left + spacing.rail;
	const railRight = kids.right - spacing.rail;
	const turnY = parent.bottom + spacing.stem;
	const firstBus = rows[0].top - spacing.bus;

	for (const [index, row] of rows.entries()) {
		const busY = row.top - spacing.bus;
		const returnY = row.bottom + spacing.bus;
		for (const cell of row.cells) {
			const launch = [
				{ x: portOut, y: parent.bottom },
				{ x: portOut, y: firstBus },
			];
			if (index > 0) launch.push({ x: railLeft, y: firstBus }, { x: railLeft, y: busY });
			launch.push({ x: cell.card.cx, y: busY }, { x: cell.card.cx, y: cell.card.top });

			const lane = cell.right + spacing.lane;
			const ret = [
				{ x: cell.card.right, y: cell.card.cy },
				{ x: lane, y: cell.card.cy },
				{ x: lane, y: returnY },
				{ x: railRight, y: returnY },
			];
			const reader = readers.get(cell.key);
			if (reader && reader.top - spacing.stem > returnY) {
				// On down the rail, then over the reader's port and into the top of its card.
				const arriveY = reader.top - spacing.stem;
				const readerPort = reader.cx + spacing.port;
				ret.push({ x: railRight, y: arriveY }, { x: readerPort, y: arriveY }, { x: readerPort, y: reader.top });
			} else {
				ret.push({ x: railRight, y: turnY }, { x: portIn, y: turnY }, { x: portIn, y: parent.bottom });
			}
			routes.set(cell.key, { launch: tidy(launch), ret: tidy(ret) });
		}
	}
	return routes;
}

const distance = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

function toward(from, to, length) {
	const total = distance(from, to) || 1;
	return { x: from.x + ((to.x - from.x) * length) / total, y: from.y + ((to.y - from.y) * length) / total };
}

/** An SVG path through `points`, its corners rounded. */
export function pathData(points, radius = 7) {
	const round = (n) => Math.round(n * 100) / 100;
	let d = `M${round(points[0].x)} ${round(points[0].y)}`;
	for (let i = 1; i < points.length - 1; i += 1) {
		const before = points[i - 1];
		const corner = points[i];
		const after = points[i + 1];
		const r = Math.min(radius, distance(before, corner) / 2, distance(corner, after) / 2);
		const enter = toward(corner, before, r);
		const leave = toward(corner, after, r);
		d += ` L${round(enter.x)} ${round(enter.y)} Q${round(corner.x)} ${round(corner.y)} ${round(leave.x)} ${round(leave.y)}`;
	}
	const last = points.at(-1);
	return `${d} L${round(last.x)} ${round(last.y)}`;
}

/** The length of a polyline, corners square: the rounded path is a little shorter. */
export function lengthOf(points) {
	return points.slice(1).reduce((sum, point, i) => sum + distance(points[i], point), 0);
}

/** The polyline shortened by `length` at each end: what is laid over it stops short of the cards. */
export function trim(points, length) {
	if (points.length < 2 || lengthOf(points) <= 4 * length) return points;
	const out = [...points];
	const last = points.length - 1;
	out[0] = toward(points[0], points[1], Math.min(length, distance(points[0], points[1])));
	out[last] = toward(points[last], points[last - 1], Math.min(length, distance(points[last], points[last - 1])));
	return out;
}

/**
 * How far `point` lies from the polyline `points`. Lines that share a stretch lie at the same
 * distance from a point on it: this is how a click on that stretch finds every one of them.
 */
export function distanceTo(points, point) {
	let best = Number.POSITIVE_INFINITY;
	for (let i = 1; i < points.length; i += 1) {
		const a = points[i - 1];
		const dx = points[i].x - a.x;
		const dy = points[i].y - a.y;
		const squared = dx * dx + dy * dy;
		const t = squared ? Math.max(0, Math.min(1, ((point.x - a.x) * dx + (point.y - a.y) * dy) / squared)) : 0;
		best = Math.min(best, Math.hypot(point.x - (a.x + t * dx), point.y - (a.y + t * dy)));
	}
	return best;
}
