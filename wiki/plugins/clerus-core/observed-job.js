/*\
title: $:/plugins/clerus/core/observed-job.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var jobState = require("$:/plugins/clerus/core/job-state.js");

/*
Read subscriptions, not execution authority.

The caller decides which persistent jobs this runtime observes.
*/
exports.read = function (fields, platform) {
	schemas.assertPlatform(platform);

	var space = jobTitles.classify(fields.title);

	if (!space) {
		throw new Error("Observation requires a job title");
	}

	if (!space.persistent) {
		return schemas.ephemeralJob(fields, platform);
	}

	if (!jobState.hasExecutionHeader(fields)) {
		throw new Error("Observed persistent job has an invalid header");
	}

	return {
		title: fields.title,
		executor: fields["clerus-executor"],
		custody: fields["clerus-custody"] || "user",
		registry: schemas.registry(
			JSON.parse(fields.text),
			"operational"
		)
	};
};