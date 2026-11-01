/*\
title: $:/plugins/clerus/core2/missions.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var missionSchema = require(
	"$:/plugins/clerus/core2/mission-schema.js"
);
var generations = require(
	"$:/plugins/clerus/core2/generations.js"
);
var jobTitles = require(
	"$:/plugins/clerus/core2/job-titles.js"
);
var hierarchy = require(
	"$:/plugins/clerus/core2/hierarchy.js"
);

function roleId(project, role) {
	return JSON.stringify([project, role]);
}

function documentId(document) {
	return JSON.stringify([
		document.project,
		document.role,
		document.link
	]);
}

function evaluate(input) {
	var jobs = schemas.copyJSON(input);
	var graph = hierarchy.evaluate(jobs);

	var byTitle = new Map();
	var nodes = new Map();
	var roots = new Map();
	var invalidRoots = new Set();
	var records = [];
	var issues = [];
	var selected = new Map();
	var malformed = false;

	jobs.forEach(function (job) {
		byTitle.set(job.title, job);

		if (!schemas.isRecord(job.registry)) {
			return;
		}

		Object.keys(job.registry).sort().forEach(function (key) {
			var serialized = job.registry[key];

			if (
				!schemas.isRecord(serialized) ||
				serialized.form !== "mission"
			) {
				return;
			}

			var document;

			try {
				document = missionSchema.validate(serialized);
			} catch (error) {
				malformed = true;

				records.push({
					title: job.title,
					key: key,
					invalid: true
				});

				issues.push({
					type: "invalid-mission",
					title: job.title,
					key: key,
					error: error.message
				});

				if (
					typeof serialized.project === "string" &&
					Array.isArray(serialized.role) &&
					serialized.role.length === 0
				) {
					invalidRoots.add(serialized.project);
				}

				return;
			}

			var id = documentId(document);

			if (!nodes.has(id)) {
				nodes.set(id, {
					id: id,
					document: document,
					signatures: new Set(),
					holders: new Map()
				});
			}

			var node = nodes.get(id);

			node.signatures.add(
				missionSchema.delegationSignature(document)
			);

			if (!node.holders.has(job.title)) {
				node.holders.set(job.title, []);
			}

			node.holders.get(job.title).push(key);

			records.push({
				title: job.title,
				key: key,
				nodeId: id
			});

			if (document.role.length === 0) {
				var previous = roots.get(document.project);

				if (
					!previous ||
					generations.compare(
						document.link,
						previous.document.link
					) > 0
				) {
					roots.set(document.project, node);
				}
			}
		});
	});

	var immediate = new Map();

	graph.edges.forEach(function (edge) {
		if (!immediate.has(edge.from)) {
			immediate.set(edge.from, new Set());
		}

		immediate.get(edge.from).add(edge.to);
	});

	function holderOf(node) {
		return Array.from(node.holders.keys())[0];
	}

	function eligibleHolder(title) {
		var job = byTitle.get(title);
		var space = jobTitles.classify(title);

		return space.persistent ||
			job.custody === space.platform;
	}

	function subordinate(parentTitle, childTitle) {
		return parentTitle === childTitle ||
			(
				immediate.has(parentTitle) &&
				immediate.get(parentTitle).has(childTitle)
			);
	}

	function select(project, role) {
		var id = roleId(project, role);

		if (selected.has(id)) {
			return selected.get(id);
		}

		var node = null;
		var parent = null;
		var reason = null;

		if (!graph.complete) {
			reason = "incomplete-hierarchy";
		} else if (!graph.valid) {
			reason = "invalid-hierarchy";
		} else if (invalidRoots.has(project)) {
			reason = "invalid-root";
		} else if (role.length === 0) {
			node = roots.get(project) || null;

			if (!node) {
				reason = "missing-root";
			}
		} else {
			var parentResult = select(
				project,
				role.slice(0, -1)
			);

			if (!parentResult.active) {
				reason = "inactive-parent";
			} else {
				parent = parentResult.node;

				var segment = role[role.length - 1];
				var children = parent.document.children;

				if (
					!Object.prototype.hasOwnProperty.call(
						children,
						segment
					)
				) {
					reason = "missing-binding";
				} else {
					node = nodes.get(JSON.stringify([
						project,
						role,
						children[segment]
					])) || null;

					if (!node) {
						reason = "missing-assignment";
					}
				}
			}
		}

		if (node && !reason) {
			if (node.holders.size !== 1) {
				reason = "ambiguous-holder";
			} else if (node.signatures.size !== 1) {
				reason = "conflicting-copies";
			} else if (!eligibleHolder(holderOf(node))) {
				reason = "ephemeral-custody";
			} else if (
				parent &&
				!subordinate(holderOf(parent), holderOf(node))
			) {
				reason = "invalid-subordination";
			}
		}

		var result = {
			active: node !== null && reason === null,
			node: node,
			reason: reason
		};

		selected.set(id, result);

		return result;
	}

	var active = [];

	nodes.forEach(function (node) {
		var document = node.document;
		var result = select(document.project, document.role);

		if (result.active && result.node.id === node.id) {
			active.push({
				title: holderOf(node),
				keys: node.holders.get(holderOf(node)).slice(),
				project: document.project,
				role: document.role.slice(),
				link: document.link,
				issued: document.issued,
				children: schemas.copyJSON(document.children)
			});
		}

		if (node.holders.size > 1) {
			issues.push({
				type: "ambiguous-holder",
				project: document.project,
				role: document.role.slice(),
				link: document.link,
				holders: Array.from(node.holders.keys()).sort()
			});
		}

		if (node.signatures.size > 1) {
			issues.push({
				type: "conflicting-copies",
				project: document.project,
				role: document.role.slice(),
				link: document.link
			});
		}
	});

	var entries = records.map(function (record) {
		if (record.invalid) {
			return {
				title: record.title,
				key: record.key,
				active: false,
				reason: "invalid-mission"
			};
		}

		var node = nodes.get(record.nodeId);
		var document = node.document;
		var result = select(document.project, document.role);
		var matches = result.node !== null &&
			result.node.id === node.id;

		return {
			title: record.title,
			key: record.key,
			project: document.project,
			role: document.role.slice(),
			link: document.link,
			active: matches && result.active,
			reason: matches
				? result.reason
				: result.node
					? "superseded"
					: result.reason
		};
	});

	function compare(left, right) {
		var a = JSON.stringify(left);
		var b = JSON.stringify(right);

		return a < b ? -1 : a > b ? 1 : 0;
	}

	active.sort(compare);
	entries.sort(compare);
	issues.sort(compare);

	return {
		valid: graph.valid && issues.length === 0,
		complete: graph.complete && !malformed,
		active: active,
		entries: entries,
		issues: issues,
		hierarchy: graph
	};
}

exports.evaluate = evaluate;