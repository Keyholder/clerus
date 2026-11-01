/*\
title: $:/plugins/clerus/core2/message-service.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");
var policy = require("$:/plugins/clerus/core2/message-policy.js");

function create(options) {
	schemas.assertPlatform(options.platform);

	if (
		!jobTitles.isJobTitle(options.title) ||
		typeof options.readJobs !== "function"
	) {
		throw new Error("Message service requires an owner and job reader");
	}

	function prepareOrder(target, registry, scope) {
		var jobs = schemas.copyJSON(options.readJobs());

		if (!Array.isArray(jobs)) {
			throw new Error("Job reader must return an array");
		}

		var owners = jobs.filter(function (job) {
			return job.title === options.title;
		});

		if (owners.length !== 1) {
			throw new Error(
				"Message service requires exactly one owner snapshot"
			);
		}

		owners[0].registry = schemas.registry(
			scope.operational,
			"operational"
		);

		return policy.check({
			type: "order",
			platform: options.platform,
			source: options.title,
			recipient: target,
			jobs: jobs,
			registry: registry
		});
	}

	return Object.freeze({
		prepareOrder: prepareOrder
	});
}

exports.create = create;