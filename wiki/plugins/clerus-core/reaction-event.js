/*\
title: $:/plugins/clerus/core/reaction-event.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");

function define(record, key, value) {
	Object.defineProperty(record, key, {
		value: value,
		enumerable: true,
		writable: true,
		configurable: true
	});
}

function freezeTree(value) {
	if (value !== null && typeof value === "object") {
		Object.keys(value).forEach(function (key) {
			freezeTree(value[key]);
		});

		Object.freeze(value);
	}

	return value;
}

function prepare(options) {
	schemas.assertPlatform(options.platform);

	if (
		typeof options.title !== "string" ||
		options.title.length === 0
	) {
		throw new Error("Reaction event requires a title");
	}

	var establishing = options.establishing === true;

	var event = schemas.copyJSON(
		establishing && options.event === undefined
			? { type: "order" }
			: options.event
	);

	if (
		!schemas.isRecord(event) ||
		typeof event.type !== "string" ||
		event.type.length === 0 ||
		(establishing && event.type !== "order")
	) {
		throw new Error("Reaction requires a valid event type");
	}

	define(event, "title", options.title);
	define(event, "platform", options.platform);

	return freezeTree(event);
}

exports.prepare = prepare;