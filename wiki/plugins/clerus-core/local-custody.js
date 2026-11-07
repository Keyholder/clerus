/*\
title: $:/plugins/clerus/core/local-custody.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var custodySchema = require(
	"$:/plugins/clerus/core/custody-schema.js"
);

/*
Local execution perspective.

This service answers only whether this runtime owns the supplied
tiddler state. Accepted material transition authority is separate.

The receiving side of relocation requires durable local evidence
of the accompanying source WAL deletion.

Source-side recognition of active relocation work is not enabled
yet. Work creation of relocations remains prohibited.
*/
function create(options) {
	var platform = schemas.assertPlatform(options.platform);
	var store = options.store;

	if (
		store !== undefined &&
		(
			!store ||
			typeof store.read !== "function"
		)
	) {
		throw new Error(
			"Local custody requires a state reader"
		);
	}

	function owns(fields) {
		if (!schemas.isRecord(fields)) {
			throw new Error(
				"Local custody requires a tiddler field record"
			);
		}

		if (fields["clerus-custody"] !== platform) {
			return false;
		}

		var transfer;

		try {
			transfer = custodySchema.readTransfer(fields);
		} catch (error) {
			/*
				Malformed serialized transfer data cannot grant
				local ownership.
			*/
			return false;
		}

		if (transfer === null) {
			return true;
		}

		if (!store) {
			return false;
		}

		var evidenceTitle;

		try {
			evidenceTitle = custodySchema.deletionTitle(
				platform,
				transfer.journal
			);
		} catch (error) {
			return false;
		}

		/*
			Read failures are infrastructure failures.
			Do not hide them in a malformed-data catch.
		*/
		var stored = store.read(evidenceTitle);

		if (
			!schemas.isRecord(stored) ||
			(
				stored.kind !== "absent" &&
				stored.kind !== "materialized" &&
				stored.kind !== "shadow"
			)
		) {
			throw new Error(
				"Invalid custody evidence store view"
			);
		}

		if (stored.kind !== "materialized") {
			return false;
		}

		var evidence;

		try {
			evidence = custodySchema.readDeletion(
				stored.fields,
				platform
			);
		} catch (error) {
			return false;
		}

		return evidence.journal === transfer.journal;
	}

	return Object.freeze({
		owns: owns
	});
}

exports.create = create;