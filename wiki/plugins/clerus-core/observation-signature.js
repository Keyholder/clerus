/*\
title: $:/plugins/clerus/core/observation-signature.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");

function canonical(value) {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}

	if (schemas.isRecord(value)) {
		var result = Object.create(null);

		Object.keys(value).sort().forEach(function (key) {
			Object.defineProperty(result, key, {
				value: canonical(value[key]),
				enumerable: true,
				writable: true,
				configurable: true
			});
		});

		return result;
	}

	return value;
}

exports.signature = function (value) {
	return JSON.stringify(canonical(schemas.copyJSON(value)));
};