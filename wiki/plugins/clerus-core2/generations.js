/*\
title: $:/plugins/clerus/core/generations.js
type: application/javascript
module-type: library
\*/

"use strict";

function isOrdinal(value) {
	return typeof value === "string" &&
		/^(0|[1-9][0-9]*)$/.test(value);
}

function isLabel(value) {
	return typeof value === "string" &&
		/^(0|[1-9][0-9]*)(\/(0|[1-9][0-9]*))*$/.test(value);
}

function assertOrdinal(value) {
	if (!isOrdinal(value)) {
		throw new Error("Invalid generation ordinal");
	}

	return value;
}

function compare(left, right) {
	assertOrdinal(left);
	assertOrdinal(right);

	if (left.length !== right.length) {
		return left.length < right.length ? -1 : 1;
	}

	return left < right ? -1 : left > right ? 1 : 0;
}

function increment(value) {
	assertOrdinal(value);

	var digits = value.split("");

	for (var index = digits.length - 1; index >= 0; index--) {
		if (digits[index] !== "9") {
			digits[index] = String.fromCharCode(
				digits[index].charCodeAt(0) + 1
			);

			return digits.join("");
		}

		digits[index] = "0";
	}

	return "1" + digits.join("");
}

function child(parent, ordinal) {
	if (!isLabel(parent)) {
		throw new Error("Invalid parent generation");
	}

	assertOrdinal(ordinal);

	if (ordinal === "0") {
		throw new Error("Issued generation must be positive");
	}

	return parent + "/" + ordinal;
}

function localOrdinal(parent, label) {
	if (!isLabel(parent) || !isLabel(label)) {
		throw new Error("Invalid generation label");
	}

	var prefix = parent + "/";

	if (label.indexOf(prefix) !== 0) {
		return null;
	}

	var suffix = label.slice(prefix.length);

	return isOrdinal(suffix) ? suffix : null;
}

exports.isOrdinal = isOrdinal;
exports.isLabel = isLabel;
exports.compare = compare;
exports.increment = increment;
exports.child = child;
exports.localOrdinal = localOrdinal;