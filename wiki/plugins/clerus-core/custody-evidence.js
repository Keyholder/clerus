/*\
title: $:/plugins/clerus/core/custody-evidence.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var custodySchema = require(
	"$:/plugins/clerus/core/custody-schema.js"
);
var stores = require("$:/plugins/clerus/core/store.js");

/*
Infrastructure service.

recordWalDeletion() records a fact supplied by the environment:
the local platform received deletion of the specified source WAL.

It does not discover that fact by checking WAL absence.
It does not confirm another runtime's authority or completion.
*/
function create(options) {
	var platform = schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.store.read !== "function" ||
		typeof options.store.apply !== "function"
	) {
		throw new Error(
			"Custody evidence requires a state store"
		);
	}

	function lookup(journal) {
		var title = custodySchema.deletionTitle(
			platform,
			journal
		);

		var current = options.store.read(title);

		if (current.kind === "absent") {
			return {
				kind: "absent",
				title: title,
				record: null
			};
		}

		if (current.kind !== "materialized") {
			throw new Error(
				"WAL deletion evidence is shadow-backed"
			);
		}

		var record = custodySchema.readDeletion(
			current.fields,
			platform
		);

		return {
			kind: "recorded",
			title: title,
			record: record
		};
	}

	function recordWalDeletion(journal) {
		var previous = lookup(journal);

		if (previous.kind === "recorded") {
			/*
				User custody does not erase the fact and does not
				authorize reclaiming or rewriting its tiddler.
			*/
			return {
				status: "already-recorded",
				title: previous.title
			};
		}

		var record = custodySchema.deletion({
			version: 1,
			kind: "wal-deletion",
			platform: platform,
			journal: journal
		}, platform);

		var fields = {
			title: previous.title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-custody-kind": "wal-deletion",
			text: JSON.stringify(record)
		};

		try {
			options.store.apply(stores.transition(
				previous.title,
				null,
				fields
			));
		} catch (cause) {
			var error = new Error(
				String(cause && cause.message || cause)
			);

			error.name = "CustodyEvidenceRegistrationError";
			error.cause = cause;
			error.evidenceTitle = previous.title;
			error.recordingUncertain = true;

			throw error;
		}

		return {
			status: "recorded",
			title: previous.title
		};
	}

	return Object.freeze({
		lookup: lookup,
		recordWalDeletion: recordWalDeletion
	});
}

exports.create = create;