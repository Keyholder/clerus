/*\
title: $:/plugins/clerus/core/local-custody.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var stores = require("$:/plugins/clerus/core/store.js");
var envelopes = require("$:/plugins/clerus/core/wal-envelope.js");
var custodySchema = require(
	"$:/plugins/clerus/core/custody-schema.js"
);
var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);

function create(options) {
	var platform = schemas.assertPlatform(options.platform);
	var store = options.store;

	if (
		store !== undefined &&
		(!store || typeof store.read !== "function")
	) {
		throw new Error("Local custody requires a state reader");
	}

	function read(title) {
		/*
			Source failures propagate. Serialized-data failures
			are handled by the corresponding protocol readers.
		*/
		var stored = store.read(title);

		if (
			!schemas.isRecord(stored) ||
			(
				stored.kind !== "absent" &&
				stored.kind !== "materialized" &&
				stored.kind !== "shadow"
			)
		) {
			throw new Error("Invalid custody store view");
		}

		return stored;
	}

	function sourceOwns(fields, marker) {
		var stored = read(marker.journal);

		if (stored.kind !== "materialized") {
			return false;
		}

		var record;

		try {
			record = continuations.validate(
				envelopes.requireRecord(
					stored.fields,
					platform,
					"continuation"
				),
				platform,
				marker.journal
			);
		} catch (error) {
			return false;
		}

		if (
			record.work === null ||
			record.work.id !== marker.work
		) {
			return false;
		}

		var effect = record.work.transitions.find(
			function (candidate) {
				return candidate.title === fields.title;
			}
		);

		if (
			!effect ||
			effect.before === null ||
			effect.after === null ||
			effect.before["clerus-custody"] !== platform ||
			effect.after["clerus-custody"] !== marker.to
		) {
			return false;
		}

		var normalized;

		try {
			normalized = stores.transition(
				fields.title,
				fields,
				fields
			).after;
		} catch (error) {
			return false;
		}

		/*
			The active work authorizes this exact materialized
			destination, not an arbitrary state with a copied marker.
		*/
		return (
			JSON.stringify(normalized) ===
				JSON.stringify(effect.after)
		);
	}

	function destinationOwns(marker) {
		var title;

		try {
			title = custodySchema.deletionTitle(
				platform,
				marker.journal
			);
		} catch (error) {
			return false;
		}

		var stored = read(title);

		if (stored.kind !== "materialized") {
			return false;
		}

		var record;

		try {
			record = custodySchema.readDeletion(
				stored.fields,
				platform
			);
		} catch (error) {
			return false;
		}

		return record.journal === marker.journal;
	}

	function owns(fields) {
		if (!schemas.isRecord(fields)) {
			throw new Error(
				"Local custody requires a tiddler field record"
			);
		}

		var marker;

		try {
			marker = custodySchema.readTransfer(fields);
		} catch (error) {
			return false;
		}

		if (marker === null) {
			return fields["clerus-custody"] === platform;
		}

		if (!store) {
			return false;
		}

		if (marker.from === platform) {
			return sourceOwns(fields, marker);
		}

		if (marker.to === platform) {
			return destinationOwns(marker);
		}

		return false;
	}

	return Object.freeze({
		owns: owns
	});
}

exports.create = create;