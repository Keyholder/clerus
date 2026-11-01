/*\
title: $:/plugins/clerus/core2/organization.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");
var hierarchy = require("$:/plugins/clerus/core2/hierarchy.js");

function create(options) {
	if (
		!jobTitles.isJobTitle(options.title) ||
		typeof options.readJobs !== "function"
	) {
		throw new Error("Organization service requires an owner and job reader");
	}

	function authorizeChange(before, after) {
		/*
		Scope already detects the appearance of a new operational
		reference. Here we validate the complete proposed graph.
		*/
		schemas.registry(before.operational, "operational");

		var proposed = schemas.registry(
			after.operational,
			"operational"
		);

		var jobs = schemas.copyJSON(options.readJobs());

		if (!Array.isArray(jobs)) {
			throw new Error("Job reader must return an array");
		}

		var owners = jobs.filter(function (job) {
			return job.title === options.title;
		});

		if (owners.length !== 1) {
			throw new Error(
				"Organization requires exactly one owner snapshot"
			);
		}

		owners[0].registry = proposed;

		var graph = hierarchy.evaluate(jobs);

		if (!graph.complete) {
			throw new Error(
				"Cannot establish a reference in an incomplete hierarchy"
			);
		}

		if (!graph.valid) {
			throw new Error(
				"Operational reference would violate hierarchy invariants"
			);
		}
	}

	return Object.freeze({
		authorizeChange: authorizeChange
	});
}

exports.create = create;