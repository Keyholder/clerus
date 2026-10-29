/*\
title: $:/plugins/clerus/core/missions.js
type: application/javascript
module-type: library
\*/

"use strict";

var links = require("$:/plugins/clerus/core/mission-links.js");

function isRecord(value) {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value);
}

function sameIdentity(left, right) {
	return links.isMission(left) &&
		links.isMission(right) &&
		left.project === right.project &&
		left.link === right.link &&
		JSON.stringify(left.role) === JSON.stringify(right.role);
}

function audit(jobs) {
	var result = links.evaluate(jobs);

	var invalid = result.entries.filter(function (entry) {
		return entry.reason === "invalid-mission";
	});

	var conflicts = result.issues.filter(function (issue) {
		return issue.type === "ambiguous-holder" ||
			issue.type === "conflicting-copies";
	});

	return {
		valid: invalid.length === 0 && conflicts.length === 0,
		active: result.active,
		inactive: result.entries.filter(function (entry) {
			return !entry.active;
		}),
		invalid: invalid,
		conflicts: conflicts,
		issues: result.issues
	};
}

function resolveNode(tree, role) {
	var node = tree;

	for (var index = 0; index <= role.length; index++) {
		if (
			!isRecord(node) ||
			!Object.prototype.hasOwnProperty.call(node, "task") ||
			!isRecord(node.parts)
		) {
			throw new Error("Invalid task node");
		}

		if (index === role.length) {
			return node;
		}

		if (
			!Object.prototype.hasOwnProperty.call(
				node.parts, role[index]
			)
		) {
			throw new Error("Task does not exist");
		}

		node = node.parts[role[index]];
	}
}

function read(wiki, jobs, holder, document) {
	var view = {
		exists: false,
		active: false,
		readable: false,
		task: null,
		reason: null
	};

	if (!links.isMission(document)) {
		view.reason = "Invalid mission";
		return view;
	}

	var project = wiki.getTiddler(document.project);

	view.exists = !!project;

	var evaluation = links.evaluate(jobs);
	var assignment = evaluation.active.find(function (entry) {
		return entry.title === holder &&
			entry.project === document.project &&
			entry.link === document.link &&
			JSON.stringify(entry.role) === JSON.stringify(document.role);
	});

	if (!assignment) {
		var recorded = evaluation.entries.find(function (entry) {
			return entry.title === holder &&
				entry.project === document.project &&
				entry.link === document.link &&
				JSON.stringify(entry.role) === JSON.stringify(document.role);
		});

		view.reason = recorded
			? recorded.reason || "Inactive mission"
			: "Assignment is no longer held";

		return view;
	}

	view.active = true;

	if (!project) {
		view.reason = "Project does not exist";
		return view;
	}

	try {
		if (project.fields.type !== "application/json") {
			throw new Error("Project must have type application/json");
		}

		view.task = resolveNode(
			JSON.parse(project.fields.text),
			document.role
		).task;

		view.readable = true;
	} catch (error) {
		view.reason = String(error.message);
	}

	return view;
}

exports.isMission = links.isMission;
exports.sameIdentity = sameIdentity;
exports.audit = audit;
exports.read = read;
exports.resolveNode = resolveNode;