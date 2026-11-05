/*\
title: $:/plugins/clerus/core/materialization-barrier.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var acceptedPlans = require(
	"$:/plugins/clerus/core/accepted-plan-schema.js"
);
var flowSchema = require(
	"$:/plugins/clerus/core/flow-schema.js"
);
var deferredSchema = require(
	"$:/plugins/clerus/core/deferred-schema.js"
);
var incidentSchema = require(
	"$:/plugins/clerus/core/incident-schema.js"
);
var walEnvelope = require(
	"$:/plugins/clerus/core/wal-envelope.js"
);

function collect(options) {
	if (
		!options.store ||
		typeof options.store.snapshot !== "function"
	) {
		throw new Error("Materialization barrier requires a snapshot store");
	}

	var snapshot = options.store.snapshot();
	var blocked = new Map();
	var unreadable = [];

	snapshot.materialized.forEach(function (fields) {
		var platform = walEnvelope.platformOf(fields.title);

		if (platform === null) {
			return;
		}

		try {
			var envelope = walEnvelope.read(fields);

			if (envelope.kind !== "ready") {
				throw new Error(envelope.reason);
			}

			var record = envelope.record;
			var kind = record.kind;

			if (kind === "incident") {
				incidentSchema.validate(record, platform);

				// Valid diagnostic history is not unfinished materialization.
				return;
			}

			if (kind === "flow") {
				var flow = flowSchema.validate(record, platform);

				if (flow.active !== null) {
					var flowOwner = flow.active.owner.title;

					if (!blocked.has(flowOwner)) {
						blocked.set(flowOwner, []);
					}

					blocked.get(flowOwner).push(fields.title);
				}

				return;
			}

			if (kind === "deferred") {
				var deferredRecord = deferredSchema.validate(
					record,
					platform
				);

				if (
					fields.title !==
						"$:/clerus/wal/" + platform +
						"/deferred-" + deferredRecord.effect.id ||
					fields["clerus-deferred-effect"] !==
						JSON.stringify(deferredRecord.effect)
				) {
					throw new Error("Deferred obligation identity mismatch");
				}

				// Waiting for an event is not active materialization.
				return;
			}

			if (kind !== "plan") {
				throw new Error("Unsupported WAL kind");
			}

			var accepted = acceptedPlans.validate(record, platform);
			var owner = accepted.proposal.owner.title;

			if (!blocked.has(owner)) {
				blocked.set(owner, []);
			}

			blocked.get(owner).push(fields.title);
		} catch (error) {
			unreadable.push({
				title: fields.title,
				error: String(error && error.message || error)
			});
		}
	});

	unreadable.sort(function (left, right) {
		return left.title < right.title
			? -1
			: left.title > right.title ? 1 : 0;
	});

	blocked.forEach(function (titles) {
		titles.sort();
	});

	return Object.freeze({
		forJob: function (title) {
			var space = jobTitles.classify(title);

			if (!space || !space.persistent) {
				return [];
			}

			var result = unreadable.map(function (entry) {
				return entry.title;
			});

			result = result.concat(blocked.get(title) || []);

			return Array.from(new Set(result)).sort();
		},

		inspect: function () {
			return {
				complete: unreadable.length === 0,

				unreadable: schemas.copyJSON(unreadable),

				blocked: Array.from(blocked.keys()).sort().map(
					function (title) {
						return {
							title: title,
							obligations: blocked.get(title).slice()
						};
					}
				)
			};
		}
	});
}

exports.collect = collect;