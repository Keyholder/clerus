/*\
title: $:/plugins/clerus/core/obligation-summary.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var envelopes = require("$:/plugins/clerus/core/wal-envelope.js");
var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);

function evaluate(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.store.snapshot !== "function"
	) {
		throw new Error(
			"Obligation summary requires a snapshot store"
		);
	}

	var result = {
		complete: true,
		journals: {
			total: 0,
			owned: 0,
			notOwned: 0
		},
		materializations: 0,
		waiting: {
			deliveries: { ready: 0, paused: 0 },
			activations: { ready: 0, paused: 0 },
			notifications: { ready: 0, paused: 0 }
		},
		unreadable: []
	};

	options.store.snapshot().materialized.forEach(function (fields) {
		if (
			envelopes.platformOf(fields.title) !== options.platform
		) {
			return;
		}

		result.journals.total++;

		if (fields["clerus-custody"] === options.platform) {
			result.journals.owned++;
		} else {
			result.journals.notOwned++;
		}

		try {
			var record = continuations.validate(
				envelopes.requireRecord(
					fields,
					options.platform,
					"continuation"
				),
				options.platform,
				fields.title
			);

			if (record.work !== null) {
				result.materializations++;
			}

			Object.keys(record.events).forEach(function (id) {
				var entry = record.events[id];

				var buckets = {
					delivery: result.waiting.deliveries,
					activation: result.waiting.activations,
					notification: result.waiting.notifications
				};

				buckets[entry.event.kind][entry.mode]++;
			});
		} catch (error) {
			result.complete = false;

			result.unreadable.push({
				title: fields.title,
				error: String(error && error.message || error)
			});
		}
	});

	result.unreadable.sort(function (left, right) {
		return left.title < right.title
			? -1
			: left.title > right.title ? 1 : 0;
	});

	return schemas.copyJSON(result);
}

exports.evaluate = evaluate;