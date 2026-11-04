/*\
title: $:/plugins/clerus/core/organization.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var hierarchy = require("$:/plugins/clerus/core/hierarchy.js");
var jobState = require("$:/plugins/clerus/core/job-state.js");

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

		var perspective = jobState.overlayOwner(
			options.readJobs(),
			options.title,
			proposed
		);

		var graph = hierarchy.evaluate(perspective.jobs);

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