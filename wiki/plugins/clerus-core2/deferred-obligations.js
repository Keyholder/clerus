/*\
title: $:/plugins/clerus/core2/deferred-obligations.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var effects = require("$:/plugins/clerus/core2/deferred-effect.js");
var flowSchema = require("$:/plugins/clerus/core2/flow-schema.js");
var stores = require("$:/plugins/clerus/core2/store.js");

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

function create(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.store.read !== "function" ||
		typeof options.store.apply !== "function"
	) {
		throw new Error("Deferred obligations require a store");
	}

	var prefix = "$:/clerus/wal/" + options.platform + "/";

	function titleFor(effect) {
		return prefix + "deferred-" + effect.id;
	}

	function record(value) {
		var effect = effects.validate(value);

		if (effect.platform !== options.platform) {
			throw new Error("Cannot record a foreign deferred effect");
		}

		var title = titleFor(effect);
		var marker = JSON.stringify(effect);
		var current = options.store.read(title);

		if (current.kind !== "absent") {
			if (
				current.kind !== "materialized" ||
				current.fields.type !== "application/json" ||
				current.fields["clerus-deferred-effect"] !== marker
			) {
				throw new Error("Deferred identity is already occupied");
			}

			var body = JSON.parse(current.fields.text);
			var kind = current.fields["clerus-wal-kind"];

			if (kind === "deferred") {
				var previous = validate(body, options.platform);

				if (JSON.stringify(previous.effect) !== marker) {
					throw new Error("Deferred identity mismatch");
				}
			} else if (kind === "flow") {
				flowSchema.validate(body, options.platform);
			} else {
				throw new Error("Unsupported deferred continuation");
			}

			/*
				An existing paused obligation is not reclaimed.
				Its existence still satisfies registration.
			*/
			return title;
		}

		options.store.apply(stores.transition(title, null, {
			title: title,
			type: "application/json",
			"clerus-custody": options.platform,
			"clerus-wal-kind": "deferred",
			"clerus-deferred-effect": marker,

			text: JSON.stringify({
				version: 1,
				kind: "deferred",
				platform: options.platform,
				effect: effect
			})
		}));

		return title;
	}

	function read(title) {
		var current = options.store.read(title);

		if (
			current.kind !== "materialized" ||
			current.fields.type !== "application/json" ||
			current.fields["clerus-wal-kind"] !== "deferred" ||
			current.fields["clerus-custody"] !== options.platform
		) {
			throw new Error("Deferred obligation is not locally owned");
		}

		var body = validate(
			JSON.parse(current.fields.text),
			options.platform
		);

		if (
			title !== titleFor(body.effect) ||
			current.fields["clerus-deferred-effect"] !==
				JSON.stringify(body.effect)
		) {
			throw new Error("Deferred obligation identity mismatch");
		}

		return {
			fields: current.fields,
			effect: body.effect
		};
	}

	return Object.freeze({
		record: record,
		read: read
	});
}

exports.validate = validate;
exports.create = create;