/*\
title: $:/plugins/clerus/core/roles.js
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
		// Reject unpaired UTF-16 surrogates.
		encodeURIComponent(segment);
		return true;
	} catch (error) {
		return false;
	}
}

function isRole(role) {
	return Array.isArray(role) && role.every(isSegment);
}

function encodeSegment(segment) {
	if (!isSegment(segment)) {
		throw new Error("Invalid role segment");
	}

	// encodeURIComponent leaves these characters unescaped;
	// canonical URI serialization uses only unreserved literals.
	return encodeURIComponent(segment).replace(/[!'()*]/g, function (character) {
		return "%" + character.charCodeAt(0).toString(16).toUpperCase();
	});
}

function stringify(role) {
	if (!isRole(role)) {
		throw new Error("Invalid role");
	}

	return role.map(encodeSegment).join("/");
}

function parse(text) {
	if (typeof text !== "string") {
		throw new Error("Role path must be a string");
	}

	if (text === "") {
		return [];
	}

	var role = text.split("/").map(function (segment) {
		try {
			return decodeURIComponent(segment);
		} catch (error) {
			throw new Error("Invalid encoded role segment");
		}
	});

	if (!isRole(role)) {
		throw new Error("Invalid role path");
	}

	if (stringify(role) !== text) {
		throw new Error("Non-canonical role path");
	}

	return role;
}

exports.isSegment = isSegment;
exports.isRole = isRole;
exports.stringify = stringify;
exports.parse = parse;