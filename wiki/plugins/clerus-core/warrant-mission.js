/*\
title: $:/plugins/clerus/core/warrant-mission.js
type: application/javascript
module-type: library
\*/

"use strict";

var missions = require("$:/plugins/clerus/core/missions.js");
var missionPerspective =
	require("$:/plugins/clerus/core/mission-perspective.js");

function constrained(warrant) {
	return Object.prototype.hasOwnProperty.call(warrant, "mission");
}

function validate(warrant) {
	if (!constrained(warrant)) {
		return;
	}

	var reference = warrant.mission;

	if (
		!reference ||
		typeof reference !== "object" ||
		Array.isArray(reference) ||
		Object.keys(reference).length !== 3 ||
		!Object.prototype.hasOwnProperty.call(reference, "project") ||
		!Object.prototype.hasOwnProperty.call(reference, "role") ||
		!Object.prototype.hasOwnProperty.call(reference, "link") ||
		!missions.isMission({
			form: "mission",
			project: reference.project,
			role: reference.role,
			link: reference.link,
			issued: "0",
			children: {}
		})
	) {
		throw new Error("Invalid warrant mission constraint");
	}
}

function matches(document, reference) {
	return missions.isMission(document) &&
		document.project === reference.project &&
		document.link === reference.link &&
		JSON.stringify(document.role) === JSON.stringify(reference.role);
}

function authorize(options) {
	var warrant = options.warrant;

	validate(warrant);

	if (!constrained(warrant)) {
		return;
	}

	var runtime = options.runtime;
	var state = options.state;
	var source = options.job;

	var jobs = missionPerspective.jobs(
		runtime,
		state,
		source.title
	);

	var owner = jobs.find(function (job) {
		return job.title === source.title;
	});

	if (
		!owner ||
		!owner.valid ||
		!owner.local ||
		!owner.owned ||
		owner.executor !== source.executor
	) {
		throw new Error("Warrant mission owner is unavailable");
	}

	var candidates = Object.keys(owner.registry).map(function (key) {
		return owner.registry[key];
	}).filter(function (document) {
		return matches(document, warrant.mission);
	});

	if (candidates.length === 0) {
		throw new Error("Warrant requires a locally held mission");
	}

	var wiki = state
		? { getTiddler: state.getTiddler }
		: runtime.wiki;

	var active = candidates.some(function (document) {
		return missions.read(
			wiki,
			jobs,
			source.title,
			document
		).active;
	});

	if (!active) {
		throw new Error("Warrant requires an active mission");
	}
}

exports.validate = validate;
exports.authorize = authorize;