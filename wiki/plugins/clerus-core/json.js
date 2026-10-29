/*\
title: $:/plugins/clerus/core/json.js
type: application/javascript
module-type: library
\*/

"use strict";

exports.copy = function (value) {
	var text = JSON.stringify(value, function (key, item) {
		var type = typeof item;

		if (
			type === "undefined" ||
			type === "function" ||
			type === "symbol" ||
			type === "bigint"
		) {
			throw new Error("Value must be JSON-serializable");
		}

		if (type === "number" && !Number.isFinite(item)) {
			throw new Error("Value cannot contain non-finite numbers");
		}

		return item;
	});

	return JSON.parse(text);
};