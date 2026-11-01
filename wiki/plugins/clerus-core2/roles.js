/*\
title: $:/plugins/clerus/core2/roles.js
type: application/javascript
module-type: library
\*/

"use strict";

function isSegment(segment) {
	if (
		typeof segment !== "string" ||
		segment.length === 0 ||
		segment === "." ||
		segment === ".." ||
		/[\/\\?#\u0000-\u001f\u007f-\u009f]/.test(segment)
	) {
		return false;
	}

	try {
		encodeURIComponent(segment);
		return true;
	} catch (error) {
		return false;
	}
}

function isRole(role) {
	return Array.isArray(role) &&
		Array.from(role).every(isSegment);
}

function assertRole(role) {
	if (!isRole(role)) {
		throw new Error("Invalid project role");
	}

	return role.slice();
}

function encodeSegment(segment) {
	return encodeURIComponent(segment).replace(
		/[!'()*]/g,
		function (character) {
			return "%" +
				character.charCodeAt(0)
					.toString(16)
					.toUpperCase();
		}
	);
}

function stringify(role) {
	return assertRole(role).map(encodeSegment).join("/");
}

function parse(text) {
	if (typeof text !== "string") {
		throw new Error("Role path must be a string");
	}

	if (text === "") {
		return [];
	}

	var role;

	try {
		role = text.split("/").map(function (segment) {
			return decodeURIComponent(segment);
		});
	} catch (error) {
		throw new Error("Invalid encoded role path");
	}

	assertRole(role);

	if (stringify(role) !== text) {
		throw new Error("Non-canonical role path");
	}

	return role;
}

exports.isSegment = isSegment;
exports.isRole = isRole;
exports.assertRole = assertRole;
exports.stringify = stringify;
exports.parse = parse;