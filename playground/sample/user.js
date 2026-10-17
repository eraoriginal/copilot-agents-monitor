export function fullName(user) {
	return `${user.firstName} ${user.lastName}`;
}

export function initials(user) {
	return `${user.firstName[0]}${user.lastName[0]}`;
}

// TODO: validate the email address
export function contact(user) {
	return user.email;
}
