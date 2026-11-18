/*\
title: $:/plugins/clerus/tests/protocol-observation.js
type: application/javascript
module-type: library
\*/

"use strict";

var envelopes = require(
	"$:/plugins/clerus/core/wal-envelope.js"
);
var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);

/*
The runtime's top-level arrays already aggregate continuation
attempts. Nested passes are diagnostic detail, not extra attempts.

These arrays do not describe authoritative outstanding work.
*/
function attempts(report) {
	return {
		completed: (report.completed || []).slice(),
		blocked: (report.blocked || []).slice(),
		unavailable: (report.unavailable || []).slice(),
		errors: (report.errors || []).slice()
	};
}

/*
Return outstanding delivery identities, including paused events.

Unpublished work.emits are intentionally not included: this helper
observes waiting deliveries, not every accepted future emission.
*/
function pendingDeliveryIds(wiki, title) {
	if (!wiki.tiddlerExists(title)) {
		if (wiki.isShadowTiddler(title)) {
			throw new Error("Event journal is shadow-backed");
		}

		return [];
	}

	var tiddler = wiki.getTiddler(title);
	var platform = envelopes.platformOf(title);

	var record = continuations.validate(
		envelopes.requireRecord(
			require("$:/plugins/clerus/core/store.js")
				.capture(tiddler),
			platform,
			"continuation"
		),
		platform,
		title
	);

	return Object.keys(record.events).filter(function (id) {
		return record.events[id].event.kind === "delivery";
	}).sort();
}

exports.attempts = attempts;
exports.pendingDeliveryIds = pendingDeliveryIds;