/*\
title: $:/plugins/clerus/core/prototype-wal-receipts.js
type: application/javascript
module-type: library
\*/

"use strict";

var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);
var custody = require(
	"$:/plugins/clerus/core/custody-schema.js"
);

/*
Prototype heuristic, NOT transport confirmation.

A valid empty foreign continuation without diagnostics is treated
as completed immediately.

A valid incoming transfer marker also permits inferred completion
when its minimum WAL lifetime has expired and the WAL is absent.

No observation history is required.
*/
exports.create = function (options) {
	var foreign = options.platform === "browser"
		? "node"
		: "browser";

	var prefix = "$:/clerus/wal/" + foreign + "/";
	var now = options.now || Date.now;

	function scan() {
		var candidates = new Map();
		var received = [];
		var errors = [];
		var time = now();

		if (!Number.isSafeInteger(time) || time < 0) {
			throw new Error("Invalid prototype receipt clock");
		}

		options.wiki.each(function (tiddler, title) {
			if (
				title.indexOf(prefix) === 0 &&
				tiddler.fields.type === "application/json" &&
				tiddler.fields["clerus-wal-kind"] === "continuation"
			) {
				try {
					var record = continuations.validate(
						JSON.parse(tiddler.fields.text),
						foreign,
						title
					);

					if (
						record.work === null &&
						Object.keys(record.events).length === 0 &&
						record.diagnostics.length === 0
					) {
						candidates.set(title, "prototype-empty-wal");
					}
				} catch (error) {
					// Invalid data is not completion evidence.
				}
			}

			if (title.indexOf("$:/clerus/jobs/") !== 0) {
				return;
			}

			var marker;

			try {
				marker = custody.readTransfer(
					require("$:/plugins/clerus/core/store.js")
						.capture(tiddler)
				);
			} catch (error) {
				return;
			}

			if (
				marker === null ||
				marker.to !== options.platform ||
				marker.from !== foreign ||
				marker.retainUntil === undefined ||
				time < marker.retainUntil
			) {
				return;
			}

			if (
				!options.wiki.tiddlerExists(marker.journal) &&
				!options.wiki.isShadowTiddler(marker.journal)
			) {
				candidates.set(
					marker.journal,
					"prototype-expired-lifetime-and-absence"
				);
			}
		});

		Array.from(candidates.keys()).sort().forEach(function (journal) {
			try {
				var result = options.recordWalDeletion(journal);

				if (result.status === "recorded") {
					received.push({
						journal: journal,
						basis: candidates.get(journal),
						result: result
					});
				}
			} catch (error) {
				errors.push({
					journal: journal,
					error: String(error.stack || error)
				});
			}
		});

		return {
			received: received,
			errors: errors
		};
	}

	return Object.freeze({
		scan: scan
	});
};