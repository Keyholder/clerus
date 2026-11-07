/*\
title: $:/plugins/clerus/core/obligation-summary.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var envelopes = require("$:/plugins/clerus/core/wal-envelope.js");
var acceptedPlans = require(
	"$:/plugins/clerus/core/accepted-plan-schema.js"
);
var flows = require("$:/plugins/clerus/core/flow-schema.js");
var deferred = require(
	"$:/plugins/clerus/core/deferred-schema.js"
);
var incidents = require(
	"$:/plugins/clerus/core/incident-schema.js"
);
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
			notOwned: 0,
			historical: 0
		},
		materializations: 0,
		waiting: {
			deliveries: {
				ready: 0,
				paused: 0
			},
			activations: {
				ready: 0,
				paused: 0
			}
		},
		unreadable: []
	};

	options.store.snapshot().materialized.forEach(
		function (fields) {
			if (
				envelopes.platformOf(fields.title) !==
					options.platform
			) {
				return;
			}

			result.journals.total++;

			if (
				fields["clerus-custody"] === options.platform
			) {
				result.journals.owned++;
			} else {
				result.journals.notOwned++;
			}

			try {
				var envelope = envelopes.read(fields);

				if (envelope.kind !== "ready") {
					throw new Error(envelope.reason);
				}

				var record = envelope.record;

				/*
					Validate the complete body before counting
					any of its obligations.
				*/
				if (record.kind === "plan") {
					acceptedPlans.validate(
						record,
						options.platform
					);

					result.materializations++;
					return;
				}

				if (record.kind === "flow") {
					var flow = flows.validate(
						record,
						options.platform
					);

					if (flow.active !== null) {
						result.materializations++;
					}

					result.waiting.deliveries.ready +=
						flow.pending.length;

					return;
				}

				if (record.kind === "deferred") {
					var waiting = deferred.validate(
						record,
						options.platform
					);

					if (
						fields.title !==
							"$:/clerus/wal/" +
							options.platform +
							"/deferred-" +
							waiting.effect.id ||
						fields["clerus-deferred-effect"] !==
							JSON.stringify(waiting.effect)
					) {
						throw new Error(
							"Deferred obligation identity mismatch"
						);
					}

					result.waiting.activations.ready++;
					return;
				}

				if (record.kind === "incident") {
					incidents.validate(
						record,
						options.platform
					);

					result.journals.historical++;
					return;
				}

				if (record.kind === "continuation") {
					var continuation = continuations.validate(
						record,
						options.platform,
						fields.title
					);

					if (continuation.work !== null) {
						result.materializations++;
					}

					Object.keys(
						continuation.events
					).forEach(function (id) {
						var entry = continuation.events[id];
						var bucket =
							entry.event.kind === "activation"
								? result.waiting.activations
								: result.waiting.deliveries;

						bucket[entry.mode]++;
					});

					return;
				}

				throw new Error(
					"Unsupported obligation summary kind"
				);
			} catch (error) {
				result.complete = false;

				result.unreadable.push({
					title: fields.title,
					error: String(
						error && error.message || error
					)
				});
			}
		}
	);

	result.unreadable.sort(function (left, right) {
		return left.title < right.title
			? -1
			: left.title > right.title ? 1 : 0;
	});

	return schemas.copyJSON(result);
}

exports.evaluate = evaluate;