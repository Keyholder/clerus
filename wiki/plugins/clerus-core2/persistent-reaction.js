/*\
title: $:/plugins/clerus/core2/persistent-reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");
var barriers = require(
	"$:/plugins/clerus/core2/materialization-barrier.js"
);
var obligations = require(
	"$:/plugins/clerus/core2/obligations.js"
);
var plannedReactions = require(
	"$:/plugins/clerus/core2/planned-reaction.js"
);

function describe(error) {
	return {
		name: String(error && error.name || "Error"),
		message: String(error && error.message || error),
		stack: error && error.stack ? String(error.stack) : null
	};
}

function failed(phase, error, title) {
	return {
		status: "failed",
		phase: phase,
		obligation: title || null,
		acceptanceUncertain: !!(
			error && error.acceptanceUncertain
		),
		error: describe(error)
	};
}

function execute(options) {
	schemas.assertPlatform(options.platform);

	var space = jobTitles.classify(options.title);

	if (
		!space ||
		!space.persistent ||
		typeof options.handler !== "function" ||
		typeof options.newId !== "function"
	) {
		throw new Error(
			"Persistent execution requires a job, handler and identity source"
		);
	}

	var manager = obligations.create({
		store: options.store,
		platform: options.platform,
		newId: options.newId
	});

	var blockers = barriers.collect({
		store: options.store
	}).forJob(options.title);

	if (blockers.length > 0) {
		return {
			status: "blocked",
			obligations: blockers
		};
	}

	var proposal;
	var invoked = false;

	try {
		proposal = plannedReactions.execute({
			store: options.store,
			title: options.title,
			platform: options.platform,
			event: options.event,
			incoming: options.incoming,
			handler: function (event, operational, incoming) {
				invoked = true;

				return options.handler(
					event,
					operational,
					incoming
				);
			},
			acknowledgeResumption: options.acknowledgeResumption === true
		});
	} catch (error) {
		return failed(
			invoked ? "reaction" : "preparation",
			error,
			null
		);
	}

	var title;

	try {
		title = manager.accept(proposal);
	} catch (error) {
		return failed(
			"acceptance",
			error,
			error && error.obligationTitle
		);
	}

	if (title === null) {
		return {
			status: "completed",
			obligation: null,
			results: []
		};
	}

	try {
		return {
			status: "completed",
			obligation: title,
			results: manager.resume(title)
		};
	} catch (error) {
		return failed("materialization", error, title);
	}
}

exports.execute = execute;