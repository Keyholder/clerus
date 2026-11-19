/*\
title: $:/plugins/clerus/core/materialization-barrier.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var walEnvelope = require(
	"$:/plugins/clerus/core/wal-envelope.js"
);
var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);
var workPerspective = require(
	"$:/plugins/clerus/core/work-perspective.js"
);

function collect(options) {
	if (
		!options.store ||
		typeof options.store.snapshot !== "function"
	) {
		throw new Error(
			"Materialization barrier requires a snapshot store"
		);
	}

	var blocked = new Map();
	var protectedWrites = new Map();
	var unreadable = [];

	function protectWrite(title, journal) {
		if (!protectedWrites.has(title)) {
			protectedWrites.set(title, []);
		}

		protectedWrites.get(title).push(journal);
	}

	options.store.snapshot().materialized.forEach(function (fields) {
		var platform = walEnvelope.platformOf(fields.title);

		if (platform === null) {
			return;
		}

		try {
			var record = continuations.validate(
				walEnvelope.requireRecord(
					fields,
					platform,
					"continuation"
				),
				platform,
				fields.title
			);

			if (record.work === null) {
				return;
			}

			var view = workPerspective.evaluate(record.work);

			view.writes.concat(view.reads).forEach(function (title) {
				protectWrite(title, fields.title);
			});

			view.blocks.forEach(function (title) {
				if (!blocked.has(title)) {
					blocked.set(title, []);
				}

				blocked.get(title).push(fields.title);
			});
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

	protectedWrites.forEach(function (titles) {
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
			}).concat(blocked.get(title) || []);

			return Array.from(new Set(result)).sort();
		},

		forWrite: function (title) {
			if (!schemas.isOrdinaryTitle(title)) {
				throw new Error(
					"Write barrier requires an ordinary tiddler title"
				);
			}

			var result = unreadable.map(function (entry) {
				return entry.title;
			}).concat(protectedWrites.get(title) || []);

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