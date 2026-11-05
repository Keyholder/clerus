/*\
title: $:/plugins/clerus/core/continuation-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var works = require("$:/plugins/clerus/core/work-schema.js");

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
		events: emptyRecord(record.events, "Continuation events"),
		evidence: {
			identities: emptyRecord(
				record.evidence.identities,
				"Continuation identity evidence"
			),
			receipts: emptyRecord(
				record.evidence.receipts,
				"Continuation receipts"
			)
		},
		diagnostics: diagnostics
	});
}

exports.validate = validate;