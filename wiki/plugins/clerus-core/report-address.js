/*\
title: $:/plugins/clerus/core/report-address.js
type: application/javascript
module-type: library
\*/

"use strict";

var missions = require("$:/plugins/clerus/core/missions.js");
var links = require("$:/plugins/clerus/core/mission-links.js");
var hierarchy = require("$:/plugins/clerus/core/hierarchy.js");
var perspective =
	require("$:/plugins/clerus/core/mission-perspective.js");

function resolve(options) {
	var runtime = options.runtime;
	var source = options.source;
	var document = options.document;
	var planned = !!options.state &&
		options.state.mode === "planned";

	if (!missions.isMission(document) || document.role.length === 0) {
		throw new Error("Report requires a non-root mission");
	}

	if (source.persistent !== planned) {
		throw new Error("Report execution mode does not match its sender");
	}

	var realSender = runtime.inspect().jobs.find(function (job) {
		return job.title === source.title;
	});

	if (
		!realSender ||
		!realSender.valid ||
		!realSender.local ||
		!realSender.owned ||
		realSender.executor !== source.executor
	) {
		throw new Error("Sender is no longer authorized");
	}

	var jobs = perspective.jobs(runtime, options.state, source.title);
	var sender = jobs.find(function (job) {
		return job.title === source.title;
	});

	if (
		!sender ||
		!missions.sameIdentity(sender.registry[options.key], document)
	) {
		throw new Error("Sender no longer holds this mission");
	}

	var graph = hierarchy.audit(jobs);

	if (!graph.valid || !graph.complete) {
		throw new Error("Cannot report in an invalid hierarchy");
	}

	var active = links.evaluate(jobs).active;
	var held = active.find(function (entry) {
		return entry.title === source.title &&
			entry.project === document.project &&
			entry.link === document.link &&
			JSON.stringify(entry.role) === JSON.stringify(document.role);
	});

	if (!held) {
		throw new Error("Inactive mission cannot address a report");
	}

	var parentRole = document.role.slice(0, -1);
	var parent = active.find(function (entry) {
		return entry.project === document.project &&
			JSON.stringify(entry.role) === JSON.stringify(parentRole);
	});

	if (!parent || parent.title === source.title) {
		throw new Error("Report requires a distinct active superior");
	}

	var recipient = jobs.find(function (job) {
		return job.title === parent.title;
	});

	if (
		!recipient ||
		!recipient.valid ||
		!recipient.local ||
		!recipient.owned ||
		recipient.persistent !== planned
	) {
		throw new Error("Report recipient is unavailable");
	}

	return {
		jobs: jobs,
		sender: sender,
		recipient: recipient,
		role: document.role.slice()
	};
}

exports.resolve = resolve;