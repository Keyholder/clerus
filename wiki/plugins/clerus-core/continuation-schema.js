/*\
title: $:/plugins/clerus/core/continuation-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var works = require("$:/plugins/clerus/core/work-schema.js");
var events = require("$:/plugins/clerus/core/event-schema.js");

var hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);

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

function emptyRecord(value, description) {
	if (
		!schemas.isRecord(value) ||
		Object.keys(value).length !== 0
	) {
		throw new Error(description + " is not supported yet");
	}

	return Object.create(null);
}

function validate(value, platform) {
	schemas.assertPlatform(platform);

	var record = schemas.copyJSON(value);

	fieldsOnly(record, [
		"version",
		"kind",
		"platform",
		"work",
		"events",
		"evidence",
		"diagnostics"
	], "continuation");

	if (
		record.version !== 2 ||
		record.kind !== "continuation" ||
		record.platform !== platform ||
		!Array.isArray(record.diagnostics)
	) {
		throw new Error("Invalid continuation");
	}

	fieldsOnly(record.evidence, [
		"identities", "receipts"
	], "continuation evidence");

	var work = record.work === null
		? null
		: works.validate(record.work);

	if (
		!schemas.isRecord(record.events) ||
		!schemas.isRecord(record.evidence.identities)
	) {
		throw new Error("Invalid continuation events or identities");
	}

	var identities = Object.create(null);

	Object.keys(record.evidence.identities).forEach(function (id) {
		events.identity(id);

		var fingerprint = record.evidence.identities[id];

		if (typeof fingerprint !== "string") {
			throw new Error("Invalid event identity evidence");
		}

		Object.defineProperty(identities, id, {
			value: fingerprint,
			enumerable: true,
			writable: true,
			configurable: true
		});
	});

	var waiting = Object.create(null);

	Object.keys(record.events).forEach(function (id) {
		events.identity(id);

		var entry = record.events[id];

		fieldsOnly(entry, ["mode", "event"], "waiting event");

		if (entry.mode !== "ready" && entry.mode !== "paused") {
			throw new Error("Invalid waiting event mode");
		}

		var event = events.assertPlatform(
			entry.event,
			platform
		);

		if (
			!hasOwn(identities, id) ||
			identities[id] !== events.fingerprint(event)
		) {
			throw new Error("Waiting event identity is not registered");
		}

		Object.defineProperty(waiting, id, {
			value: {
				mode: entry.mode,
				event: event
			},
			enumerable: true,
			writable: true,
			configurable: true
		});
	});

	if (work !== null) {
		work.emits.forEach(function (effect) {
			events.assertPlatform(effect.event, platform);

			if (
				hasOwn(identities, effect.id) &&
				identities[effect.id] !==
					events.fingerprint(effect.event)
			) {
				throw new Error("Emitted event identity was reused");
			}
		});
	}

	if (work !== null) {
		work.transitions.forEach(function (effect) {
			var authority = effect.before === null
				? effect.after
				: effect.before;

			if (
				authority["clerus-custody"] !== platform
			) {
				throw new Error(
					"Invalid accepted work authority: " +
					effect.title
				);
			}
		});
	}

	var diagnostics = record.diagnostics.map(function (entry) {
		if (!schemas.isRecord(entry)) {
			throw new Error(
				"Continuation diagnostic must be a record"
			);
		}

		return entry;
	});

	return schemas.copyJSON({
		version: 2,
		kind: "continuation",
		platform: platform,
		work: work,
		events: waiting,
		evidence: {
			identities: identities,
			receipts: emptyRecord(
				record.evidence.receipts,
				"Continuation receipts"
			)
		},
		diagnostics: diagnostics
	});
}

exports.validate = validate;