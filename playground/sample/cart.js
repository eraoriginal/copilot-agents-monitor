// TODO: support discount codes
export function addItem(cart, item) {
	return { ...cart, items: [...cart.items, item] };
}

export function total(cart) {
	// TODO: round to the currency's precision
	return cart.items.reduce((sum, item) => sum + item.price * item.quantity, 0);
}
