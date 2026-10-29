/*\
title: $:/plugins/clerus/core/mission-perspective.js
type: application/javascript
module-type: library
\*/

"use strict";

function jobs(runtime, state, ownerTitle) {
	var result = runtime.inspect().jobs;

	if (!state) {
		return result;
	}

	var owner = result.find(function (job) {
		return job.title === ownerTitle;
	});

	if (!owner) {
		return result;
	}

	var tiddler = state.getTiddler(ownerTitle);

	if (!tiddler || tiddler.fields.type !== "application/json") {
		throw new Error("Owner is unavailable in the mission perspective");
	}

	var registry = JSON.parse(tiddler.fields.text);

	if (
		registry === null ||
		typeof registry !== "object" ||
		Array.isArray(registry)
	) {
		throw new Error("Invalid virtual owner registry");
	}

	owner.registry = registry;
	owner.custody = tiddler.fields["clerus-custody"] || "user";
	owner.owned = owner.custody === runtime.platform;
	owner.executor = tiddler.fields["clerus-executor"];

	return result;
}

exports.jobs = jobs;