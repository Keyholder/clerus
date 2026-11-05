/*\
title: $:/plugins/clerus/core/deferred-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var effects = require("$:/plugins/clerus/core/deferred-effect.js");

/*
Version 1 deferred-obligation body.

Binding to the tiddler title and clerus-deferred-effect marker
is checked separately by readers of the materialized envelope.
*/
function validate(value, platform) {
	schemas.assertPlatform(platform);

	var record = schemas.copyJSON(value);

	if (
		!schemas.isRecord(record) ||
		Object.keys(record).some(function (key) {
			return [
				"version", "kind", "platform", "effect"
			].indexOf(key) === -1;
		}) ||
		record.version !== 1 ||
		record.kind !== "deferred" ||
		record.platform !== platform
	) {
		throw new Error("Invalid deferred obligation");
	}

	var effect = effects.validate(record.effect);

	if (effect.platform !== platform) {
		throw new Error("Deferred obligation belongs to another platform");
	}

	return {
		version: 1,
		kind: "deferred",
		platform: platform,
		effect: effect
	};
}

exports.validate = validate;