/*\
title: $:/plugins/clerus/core2/message-policy.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");
var hierarchy = require("$:/plugins/clerus/core2/hierarchy.js");
var roles = require("$:/plugins/clerus/core2/roles.js");

function reachable(children, from, to) {
	var pending = [from];
	var visited = new Set();

	while (pending.length > 0) {
		var title = pending.pop();

		if (title === to) {
			return true;
		}

		if (visited.has(title)) {
			continue;
		}

		visited.add(title);

		var next = children.get(title);

		if (next) {
			next.forEach(function (child) {
				pending.push(child);
			});
		}
	}

	return false;
}

function check(options) {
	schemas.assertPlatform(options.platform);

	if (options.type !== "order" && options.type !== "report") {
		throw new Error("Invalid official message type");
	}

	if (
		!jobTitles.isJobTitle(options.source) ||
		!jobTitles.isJobTitle(options.recipient) ||
		options.source === options.recipient
	) {
		throw new Error("Official message requires distinct job endpoints");
	}

	var jobs = schemas.copyJSON(options.jobs);

	if (!Array.isArray(jobs)) {
		throw new Error("Message policy requires job snapshots");
	}

	var graph = hierarchy.evaluate(jobs);

	if (!graph.complete) {
		throw new Error("Cannot send in an incomplete hierarchy");
	}

	if (!graph.valid) {
		throw new Error("Cannot send in an invalid hierarchy");
	}

	var byTitle = new Map();

	jobs.forEach(function (job) {
		byTitle.set(job.title, job);
	});

	var registry = schemas.registry(
		options.registry,
		"outgoing"
	);

	var contracts = Object.keys(registry).filter(function (key) {
		return schemas.formOf(registry[key]) === "contract";
	});

	var establishing = !byTitle.has(options.recipient);

	if (!byTitle.has(options.source)) {
		throw new Error("Message source must be materialized");
	}

	if (
		establishing &&
		(
			options.type !== "order" ||
			contracts.length !== 1
		)
	) {
		throw new Error(
			"Absent recipient requires an order with exactly one contract"
		);
	}

	[
		options.source,
		options.recipient
	].forEach(function (title) {
		var space = jobTitles.classify(title);

		if (
			!space.persistent &&
			space.platform !== options.platform
		) {
			throw new Error("Official message cannot cross platforms");
		}
	});

	var children = new Map();

	graph.edges.forEach(function (edge) {
		if (!children.has(edge.from)) {
			children.set(edge.from, new Set());
		}

		children.get(edge.from).add(edge.to);
	});

	var superior = options.type === "order"
		? options.source
		: options.recipient;

	var subordinate = options.type === "order"
		? options.recipient
		: options.source;

	if (
		!children.has(superior) ||
		!children.get(superior).has(subordinate)
	) {
		throw new Error(
			"Official message requires immediate subordination"
		);
	}

	if (
		options.type === "report" &&
		(
			typeof options.project !== "string" ||
			options.project.length === 0 ||
			!roles.isRole(options.role) ||
			options.role.length === 0
		)
	) {
		throw new Error("Report requires a project and non-root role");
	}

	var recipientSpace = jobTitles.classify(options.recipient);

	if (establishing) {
		var contract = registry[contracts[0]];

		if (
			(contract.temp === true && recipientSpace.persistent) ||
			(contract.temp === false && !recipientSpace.persistent)
		) {
			throw new Error(
				"Contract does not permit the recipient durability"
			);
		}
	}

	Object.keys(registry).sort().forEach(function (key) {
		var document = registry[key];
		var form = schemas.formOf(document);

		if (form !== "job-title" || options.type !== "order") {
			return;
		}

		var titleSpace = jobTitles.classify(document);

		if (
			!recipientSpace.persistent &&
			titleSpace.persistent
		) {
			throw new Error(
				"An ephemeral recipient cannot receive persistent job titles in an order"
			);
		}

		/*
		Reflexive reachability rejects the recipient's own title.
		Other paths reject all its transitive superiors.
		*/
		if (reachable(children, document, options.recipient)) {
			throw new Error(
				"An order cannot carry the recipient or its superior"
			);
		}
	});

	var result = {
		type: options.type,
		platform: options.platform,
		source: options.source,
		recipient: options.recipient,
		registry: registry
	};

	if (options.type === "report") {
		result.project = options.project;
		result.role = options.role.slice();
	}

	if (establishing) {
		result.establishing = true;
		result.executor = registry[contracts[0]].executor;
	}

	return result;
}

exports.check = check;