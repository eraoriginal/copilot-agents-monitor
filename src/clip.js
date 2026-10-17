const MAX_STRING = 2000;
const MAX_ITEMS = 200;
const MAX_DEPTH = 8;

/** Tool inputs and responses can hold whole files: keep the shape, cap the size. */
export function clip(value, depth = 0) {
	if (typeof value === "string") {
		return value.length > MAX_STRING
			? `${value.slice(0, MAX_STRING)}… [${value.length - MAX_STRING} more chars]`
			: value;
	}
	if (Array.isArray(value)) {
		if (depth >= MAX_DEPTH) return "[…]";
		return value.slice(0, MAX_ITEMS).map((item) => clip(item, depth + 1));
	}
	if (value !== null && typeof value === "object") {
		if (depth >= MAX_DEPTH) return "{…}";
		return Object.fromEntries(
			Object.entries(value).map(([key, item]) => [key, clip(item, depth + 1)]),
		);
	}
	return value;
}
