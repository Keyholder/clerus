/*\
title: $:/plugins/clerus/core/mission-labels.js
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

function compare(left, right) {
	if (!isOrdinal(left) || !isOrdinal(right)) {
		throw new Error("Ordinal labels are required for comparison");
	}

	if (left.length !== right.length) {
		return left.length < right.length ? -1 : 1;
	}

	return left < right ? -1 : left > right ? 1 : 0;
}

function increment(value) {
	if (!isOrdinal(value)) {
		throw new Error("Invalid issuance counter");
	}

	var digits = value.split("");

	for (var index = digits.length - 1; index >= 0; index--) {
		if (digits[index] !== "9") {
			digits[index] = String(Number(digits[index]) + 1);
			return digits.join("");
		}

		digits[index] = "0";
	}

	return "1" + digits.join("");
}

exports.isOrdinal = isOrdinal;
exports.isLabel = isLabel;
exports.compare = compare;
exports.increment = increment;