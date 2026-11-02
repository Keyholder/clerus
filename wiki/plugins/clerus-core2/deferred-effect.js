/*\
title: $:/plugins/clerus/core/deferred-effect.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");

function fieldsOnly(record, allowed, description) {
	if (
		!schemas.isRecord(record) ||
		Object.keys(record).some(function (key) {
			return allowed.indexOf(key) === -1;
		})
	) {
		throw new Error("Unsupported fields in " + description);
	}
}

function validate(value) {
	var effect = schemas.copyJSON(value);

	fieldsOnly(effect, [
		"version",
		"kind",
		"id",
		"platform",
		"recipient"
	], "deferred effect");

	fieldsOnly(effect.recipient, [
		"title",
		"executor"
	], "deferred recipient");

	schemas.assertPlatform(effect.platform);

	var space = jobTitles.classify(effect.recipient.title);

	if (
		effect.version !== 1 ||
		effect.kind !== "deferred-event" ||
		typeof effect.id !== "string" ||
		!/^[A-Za-z0-9_-]{16,128}$/.test(effect.id) ||
		!space ||
		!space.persistent ||
		typeof effect.recipient.executor !== "string" ||
		effect.recipient.executor.length === 0
	) {
		throw new Error("Invalid persistent deferred effect");
	}

	return {
		version: 1,
		kind: "deferred-event",
		id: effect.id,
		platform: effect.platform,

		recipient: {
			title: effect.recipient.title,
			executor: effect.recipient.executor
		}
	};
}

exports.validate = validate;