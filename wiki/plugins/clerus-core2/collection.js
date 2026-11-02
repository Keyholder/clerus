/*\
title: $:/plugins/clerus/core2/collection.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");
var retention = require("$:/plugins/clerus/core2/retention.js");
var stores = require("$:/plugins/clerus/core2/store.js");

var PASSIVE_FORMS = [
	"charter",
	"memo",
	"mission",
	"contract",
	"job-title",
	"tiddler-title"
];

function collect(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.store.read !== "function" ||
		typeof options.store.snapshot !== "function" ||
		typeof options.store.apply !== "function" ||
		typeof options.readJobs !== "function" ||
		(
			options.guard !== undefined &&
			typeof options.guard !== "function"
		)
	) {
		throw new Error("Collection requires state readers and a store");
	}

	var result = {
		removed: [],
		skipped: [],
		blocked: [],
		failures: []
	};

	function guards() {
		var reasons = options.guard ? options.guard() : [];

		if (
			!Array.isArray(reasons) ||
			!reasons.every(function (reason) {
				return typeof reason === "string";
			})
		) {
			throw new Error("Collection guard must return reason strings");
		}

		return reasons.slice();
	}

	function perspective() {
		var jobs = schemas.copyJSON(options.readJobs());

		return {
			jobs: jobs,
			retention: retention.evaluate({
				jobs: jobs,
				tiddlers: options.store.snapshot().materialized
			})
		};
	}

	function analysisBarriers(view) {
		var blocked = [];

		if (!view.retention.complete) {
			blocked.push("incomplete-retention");
		}

		if (!view.retention.valid) {
			blocked.push("invalid-organization");
		}

		return blocked;
	}

	result.blocked = guards();

	if (result.blocked.length > 0) {
		return result;
	}

	var initial = perspective();

	result.blocked = analysisBarriers(initial);

	if (result.blocked.length > 0) {
		return result;
	}

	var candidates = initial.retention.candidates.slice();

	for (var index = 0; index < candidates.length; index++) {
		var title = candidates[index];

		result.blocked = guards();

		if (result.blocked.length > 0) {
			break;
		}

		var current = perspective();

		result.blocked = analysisBarriers(current);

		if (result.blocked.length > 0) {
			break;
		}

		if (current.retention.candidates.indexOf(title) === -1) {
			result.skipped.push({
				title: title,
				reason: "retained-or-absent"
			});

			continue;
		}

		var projected = current.jobs.find(function (job) {
			return job.title === title;
		});

		var stored = options.store.read(title);

		if (!projected || stored.kind !== "materialized") {
			result.skipped.push({
				title: title,
				reason: "absent"
			});

			continue;
		}

		var space = jobTitles.classify(title);

		if (
			(!space.persistent && space.platform !== options.platform) ||
			stored.fields["clerus-custody"] !== options.platform
		) {
			result.skipped.push({
				title: title,
				reason: "not-locally-owned"
			});

			continue;
		}

		var registry;

		try {
			if (
				stored.fields.type !== "application/json" ||
				typeof stored.fields["clerus-executor"] !== "string" ||
				stored.fields["clerus-executor"].length === 0
			) {
				throw new Error("Invalid job header");
			}

			registry = schemas.registry(
				JSON.parse(stored.fields.text),
				"operational"
			);
		} catch (error) {
			result.skipped.push({
				title: title,
				reason: "invalid-job"
			});

			continue;
		}

		if (
			stored.fields["clerus-executor"] !== projected.executor ||
			stored.fields["clerus-custody"] !== projected.custody ||
			JSON.stringify(registry) !==
				JSON.stringify(projected.registry)
		) {
			result.skipped.push({
				title: title,
				reason: "state-changed"
			});

			continue;
		}

		var unsupported = Object.keys(registry).some(function (key) {
			return PASSIVE_FORMS.indexOf(
				schemas.formOf(registry[key])
			) === -1;
		});

		if (unsupported) {
			result.skipped.push({
				title: title,
				reason: "unsupported-document-destruction"
			});

			continue;
		}

		try {
			options.store.apply(stores.transition(
				title,
				stored.fields,
				null
			));

			result.removed.push(title);
		} catch (error) {
			result.failures.push({
				title: title,
				error: String(error && error.message || error)
			});

			result.blocked.push("deletion-failed");
			break;
		}
	}

	return result;
}

exports.collect = collect;