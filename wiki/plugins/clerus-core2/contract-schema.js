/*\
title: $:/plugins/clerus/core2/contract-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
);

function validate(value) {
	var document = schemas.copyJSON(value);

	if (
		!schemas.isRecord(document) ||
		document.form !== "contract" ||
		typeof document.executor !== "string" ||
		document.executor.length === 0
	) {
		throw new Error("Invalid establishment contract");
	}

	if (
		hasOwn(document, "temp") &&
		typeof document.temp !== "boolean"
	) {
		throw new Error("Contract temp must be boolean");
	}

	return document;
}

exports.validate = validate;