/*\
title: $:/plugins/clerus/core/hierarchy.js
type: application/javascript
module-type: library
\*/

"use strict";

var jobViews = require("$:/plugins/clerus/core/job-view.js");

function isPersistentTitle(title) {
	return title.indexOf("$:/clerus/jobs/") === 0;
}

function audit(jobs) {
	var nodes = new Map();
	var edges = [];
	var unresolved = [];
	var violations = [];
	var uninspectable = [];

	jobs.forEach(function (job) {
		nodes.set(job.title, {
			job: job,
			children: new Set()
		});
	});

	jobs.forEach(function (job) {
		if (!job.registry) {
			uninspectable.push(job.title);
			return;
		}

		// Multiple documents pointing to the same job form one graph edge.
		var references = new Map();

		Object.keys(job.registry).sort().forEach(function (key) {
			var target = job.registry[key];

			if (!jobViews.isJobTitle(target)) {
				return;
			}

			if (!references.has(target)) {
				references.set(target, []);
			}

			references.get(target).push(key);
		});

		references.forEach(function (keys, target) {
			var edge = {
				from: job.title,
				to: target,
				keys: keys
			};

			edges.push(edge);

			if (!job.persistent && isPersistentTitle(target)) {
				violations.push({
					type: "ephemeral-superior",
					from: job.title,
					to: target,
					keys: keys
				});
			}

			if (!nodes.has(target)) {
				unresolved.push(edge);
				return;
			}

			nodes.get(job.title).children.add(target);
		});
	});

	// Find strongly connected components using Tarjan's algorithm.
	// A component with multiple nodes is cyclic.
	// A single-node component is cyclic only if it has a self-edge.
	var nextIndex = 0;
	var indexes = new Map();
	var lowLinks = new Map();
	var stack = [];
	var onStack = new Set();

	function visit(title) {
		indexes.set(title, nextIndex);
		lowLinks.set(title, nextIndex);
		nextIndex++;

		stack.push(title);
		onStack.add(title);

		var children = Array.from(nodes.get(title).children).sort();

		children.forEach(function (child) {
			if (!indexes.has(child)) {
				visit(child);

				lowLinks.set(
					title,
					Math.min(lowLinks.get(title), lowLinks.get(child))
				);
			} else if (onStack.has(child)) {
				lowLinks.set(
					title,
					Math.min(lowLinks.get(title), indexes.get(child))
				);
			}
		});

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

	edges.sort(function (a, b) {
		var left = JSON.stringify([a.from, a.to]);
		var right = JSON.stringify([b.from, b.to]);

		return left < right ? -1 : left > right ? 1 : 0;
	});

	uninspectable.sort();

	return {
		// This certifies only the inspectable materialized graph.
		valid: violations.length === 0,
		complete: uninspectable.length === 0,
		edges: edges,
		unresolved: unresolved,
		uninspectable: uninspectable,
		violations: violations
	};
}

exports.audit = audit;