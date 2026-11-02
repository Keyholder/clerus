/*\
title: $:/plugins/clerus/core/hierarchy.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");

function compareText(left, right) {
	return left < right ? -1 : left > right ? 1 : 0;
}

function evaluate(input) {
	var jobs = schemas.copyJSON(input);

	if (!Array.isArray(jobs)) {
		throw new Error("Hierarchy requires an array of jobs");
	}

	var nodes = new Map();
	var edges = [];
	var unresolved = [];
	var uninspectable = [];
	var violations = [];

	jobs.forEach(function (job) {
		if (!schemas.isRecord(job)) {
			throw new Error("Invalid hierarchy job");
		}

		var space = jobTitles.classify(job.title);

		if (!space) {
			throw new Error("Invalid hierarchy job title");
		}

		if (nodes.has(job.title)) {
			throw new Error("Duplicate hierarchy job title: " + job.title);
		}

		nodes.set(job.title, {
			job: job,
			space: space,
			children: new Set()
		});
	});

	Array.from(nodes.keys()).sort().forEach(function (title) {
		var node = nodes.get(title);
		var registry = node.job.registry;

		if (!schemas.isRecord(registry)) {
			uninspectable.push(title);
			return;
		}

		var references = new Map();

		Object.keys(registry).sort().forEach(function (key) {
			var target = registry[key];

			if (!jobTitles.isJobTitle(target)) {
				return;
			}

			if (!references.has(target)) {
				references.set(target, []);
			}

			references.get(target).push(key);
		});

		Array.from(references.keys()).sort().forEach(function (target) {
			var keys = references.get(target).slice();

			var edge = {
				from: title,
				to: target,
				keys: keys
			};

			edges.push(edge);

			var targetSpace = jobTitles.classify(target);

			if (!node.space.persistent && targetSpace.persistent) {
				violations.push({
					type: "ephemeral-superior",
					from: title,
					to: target,
					keys: keys.slice()
				});
			}

			if (!nodes.has(target)) {
				unresolved.push({
					from: title,
					to: target,
					keys: keys.slice()
				});

				return;
			}

			node.children.add(target);
		});
	});

	/*
	Strongly connected components identify cycles without
	reporting the same cyclic group once per traversal path.
	*/
	var sequence = 0;
	var indexes = new Map();
	var lowLinks = new Map();
	var stack = [];
	var onStack = new Set();

	function visit(title) {
		indexes.set(title, sequence);
		lowLinks.set(title, sequence);
		sequence++;

		stack.push(title);
		onStack.add(title);

		Array.from(nodes.get(title).children).sort().forEach(
			function (child) {
				if (!indexes.has(child)) {
					visit(child);

					lowLinks.set(
						title,
						Math.min(
							lowLinks.get(title),
							lowLinks.get(child)
						)
					);
				} else if (onStack.has(child)) {
					lowLinks.set(
						title,
						Math.min(
							lowLinks.get(title),
							indexes.get(child)
						)
					);
				}
			}
		);

		if (lowLinks.get(title) !== indexes.get(title)) {
			return;
		}

		var component = [];
		var member;

		do {
			member = stack.pop();
			onStack.delete(member);
			component.push(member);
		} while (member !== title);

		component.sort();

		if (
			component.length > 1 ||
			nodes.get(title).children.has(title)
		) {
			violations.push({
				type: "cycle",
				titles: component
			});
		}
	}

	Array.from(nodes.keys()).sort().forEach(function (title) {
		if (!indexes.has(title)) {
			visit(title);
		}
	});

	violations.sort(function (left, right) {
		return compareText(
			JSON.stringify(left),
			JSON.stringify(right)
		);
	});

	return {
		valid: violations.length === 0,
		complete: uninspectable.length === 0,
		edges: edges,
		unresolved: unresolved,
		uninspectable: uninspectable,
		violations: violations
	};
}

exports.evaluate = evaluate;