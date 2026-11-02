/*\
title: $:/plugins/clerus/core/materialization-barrier.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var materializer = require(
	"$:/plugins/clerus/core/materializer.js"
);
var flowSchema = require(
	"$:/plugins/clerus/core/flow-schema.js"
);
var deferredObligations = require(
	"$:/plugins/clerus/core/deferred-obligations.js"
);

function walPlatform(title) {
	if (title.indexOf("$:/clerus/wal/browser/") === 0) {
		return "browser";
	}

	if (title.indexOf("$:/clerus/wal/node/") === 0) {
		return "node";
	}

	return null;
}

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
		var platform = walPlatform(fields.title);

		if (platform === null) {
			return;
		}

		try {
			if (fields.type !== "application/json") {
				throw new Error("WAL must have type application/json");
			}

			var record = JSON.parse(fields.text);
			var kind = fields["clerus-wal-kind"];

			if (
				!schemas.isRecord(record) ||
				record.version !== 1 ||
				record.platform !== platform
			) {
				throw new Error("Invalid WAL envelope");
			}

			if (kind === "incident") {
				if (
					record.kind !== "incident" ||
					!schemas.isRecord(record.incident)
				) {
					throw new Error("Invalid incident envelope");
				}

				// Diagnostic history is not unfinished materialization.
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
				var deferredRecord = deferredObligations.validate(
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

			var accepted = materializer.validate(record, platform);
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