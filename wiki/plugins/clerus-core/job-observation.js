/*\
title: $:/plugins/clerus/core/job-observation.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var jobView = require("$:/plugins/clerus/core/job-view.js");
var signatures = require(
	"$:/plugins/clerus/core/observation-signature.js"
);
var observedJobs = require("$:/plugins/clerus/core/observed-job.js");

function event(title, platform, target, keys) {
	return Object.freeze({
		type: "job-status-change",
		title: title,
		platform: platform,
		target: target,
		keys: Object.freeze(keys.slice().sort())
	});
}

function collect(job, options) {
	var groups = new Map();

	Object.keys(job.registry).sort().forEach(function (key) {
		var document = job.registry[key];

		if (!jobTitles.isJobTitle(document)) {
			return;
		}

		if (!groups.has(document)) {
			groups.set(document, []);
		}

		groups.get(document).push(key);
	});

	var result = [];

	groups.forEach(function (keys, target) {
		result.push({
			id: JSON.stringify(["job-status", job.title, target]),
			signature: signatures.signature(
				jobView.read(options.store, target)
			),
			event: event(
				job.title,
				options.platform,
				target,
				keys
			)
		});
	});

	return result;
}

function refresh(value, options) {
	schemas.assertPlatform(options.platform);

	var source = schemas.copyJSON(value);

	if (
		!schemas.isRecord(source) ||
		source.type !== "job-status-change" ||
		typeof source.title !== "string" ||
		source.title.length === 0 ||
		source.platform !== options.platform ||
		!jobTitles.isJobTitle(source.target)
	) {
		throw new Error("Invalid job status observation event");
	}

	var stored = options.store.read(source.title);

	if (stored.kind === "absent") {
		return null;
	}

	if (stored.kind !== "materialized") {
		throw new Error("Observed status recipient must be materialized");
	}

	var job = observedJobs.read(
		stored.fields,
		options.platform
	);

	var keys = Object.keys(job.registry).filter(function (key) {
		return job.registry[key] === source.target;
	}).sort();

	if (keys.length === 0) {
		return null;
	}

	return event(
		source.title,
		options.platform,
		source.target,
		keys
	);
}

exports.collect = collect;
exports.refresh = refresh;