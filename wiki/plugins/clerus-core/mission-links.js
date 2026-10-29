/*\
title: $:/plugins/clerus/core/mission-links.js
type: application/javascript
module-type: library
\*/

"use strict";

var roles = require("$:/plugins/clerus/core/roles.js");
var labels = require("$:/plugins/clerus/core/mission-labels.js");

function isRecord(value) {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value);
}

var isLabel = labels.isLabel;
var compareLabels = labels.compare;

function isMission(document) {
	return isRecord(document) &&
		document.form === "mission" &&
		typeof document.project === "string" &&
		document.project.length > 0 &&
		roles.isRole(document.role) &&
		isLabel(document.link) &&
		(document.role.length !== 0 || labels.isOrdinal(document.link)) &&
		labels.isOrdinal(document.issued) &&
		isRecord(document.children) &&
		Object.keys(document.children).every(function (segment) {
			return roles.isSegment(segment) &&
				isLabel(document.children[segment]);
		});
}

function roleId(project, role) {
	return JSON.stringify([project, role]);
}

function documentId(project, role, link) {
	return JSON.stringify([project, role, link]);
}

function childrenSignature(children) {
	return JSON.stringify(
		Object.keys(children).sort().map(function (key) {
			return [key, children[key]];
		})
	);
}

function evaluate(jobs) {
	var byTitle = new Map();
	var nodes = new Map();
	var roots = new Map();
	var invalidRoots = new Set();
	var records = [];
	var issues = [];
	var memo = new Map();

	jobs.forEach(function (job) {
		byTitle.set(job.title, job);

		Object.keys(job.registry || {}).forEach(function (key) {
			var document = job.registry[key];

			if (!isRecord(document) || document.form !== "mission") {
				return;
			}

			if (!isMission(document)) {
				records.push({
					title: job.title,
					key: key,
					active: false,
					reason: "invalid-mission"
				});

				issues.push({
					type: "invalid-mission",
					title: job.title,
					key: key
				});

				if (
					typeof document.project === "string" &&
					Array.isArray(document.role) &&
					document.role.length === 0
				) {
					// Do not guess which root wins if a root is malformed.
					invalidRoots.add(document.project);
				}

				return;
			}

			var id = documentId(
				document.project,
				document.role,
				document.link
			);

			if (!nodes.has(id)) {
				nodes.set(id, {
					id: id,
					project: document.project,
					role: document.role.slice(),
					link: document.link,
					issued: document.issued,
					children: JSON.parse(JSON.stringify(document.children)),
					signatures: new Set(),
					holders: new Map()
				});
			}

			var node = nodes.get(id);

			node.signatures.add(JSON.stringify([
				childrenSignature(document.children),
				document.issued
			]));

			if (!node.holders.has(job.title)) {
				node.holders.set(job.title, []);
			}

			node.holders.get(job.title).push(key);

			records.push({
				title: job.title,
				key: key,
				project: node.project,
				role: node.role.slice(),
				link: node.link,
				nodeId: id
			});

			if (node.role.length === 0) {
				var previous = roots.get(node.project);

				if (!previous || compareLabels(node.link, previous.link) > 0) {
					roots.set(node.project, node);
				}
			}
		});
	});

	function subordinate(parentTitle, childTitle) {
		if (parentTitle === childTitle) {
			return true;
		}

		var parent = byTitle.get(parentTitle);

		return !!parent && Object.keys(parent.registry || {}).some(function (key) {
			return parent.registry[key] === childTitle;
		});
	}

	function select(project, role) {
		var id = roleId(project, role);

		if (memo.has(id)) {
			return memo.get(id);
		}

		var node = null;
		var parent = null;
		var reason = null;

		if (invalidRoots.has(project)) {
			reason = "invalid-root";
		} else if (role.length === 0) {
			node = roots.get(project) || null;

			if (!node) {
				reason = "missing-root";
			}
		} else {
			var parentResult = select(project, role.slice(0, -1));

			if (!parentResult.active) {
				reason = "inactive-parent";
			} else {
				parent = parentResult.node;

				var segment = role[role.length - 1];

				if (
					!Object.prototype.hasOwnProperty.call(
						parent.children, segment
					)
				) {
					reason = "missing-binding";
				} else {
					node = nodes.get(documentId(
						project,
						role,
						parent.children[segment]
					)) || null;

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
			} else if (
				parent &&
				!subordinate(
					Array.from(parent.holders.keys())[0],
					Array.from(node.holders.keys())[0]
				)
			) {
				reason = "invalid-subordination";
			}
		}

		var result = {
			active: !!node && !reason,
			node: node,
			reason: reason
		};

		memo.set(id, result);

		return result;
	}

	var active = [];

	nodes.forEach(function (node) {
		var selected = select(node.project, node.role);

		if (selected.active && selected.node.id === node.id) {
			active.push({
				title: Array.from(node.holders.keys())[0],
				keys: Array.from(node.holders.values())[0].slice(),
				project: node.project,
				role: node.role.slice(),
				link: node.link,
				issued: node.issued,
				children: JSON.parse(JSON.stringify(node.children))
			});
		}

		if (node.holders.size > 1) {
			issues.push({
				type: "ambiguous-holder",
				project: node.project,
				role: node.role.slice(),
				link: node.link,
				holders: Array.from(node.holders.keys()).sort()
			});
		}

		if (node.signatures.size > 1) {
			issues.push({
				type: "conflicting-copies",
				project: node.project,
				role: node.role.slice(),
				link: node.link
			});
		}
	});

	var entries = records.map(function (record) {
		if (!record.nodeId) {
			return record;
		}

		var selected = select(record.project, record.role);
		var matching = selected.node &&
			selected.node.id === record.nodeId;

		return {
			title: record.title,
			key: record.key,
			project: record.project,
			role: record.role,
			link: record.link,
			active: !!matching && selected.active,
			reason: matching
				? selected.reason
				: selected.node
					? "superseded"
					: selected.reason
		};
	});

	return {
		entries: entries,
		active: active,
		issues: issues
	};
}

exports.isLabel = isLabel;
exports.compareLabels = compareLabels;
exports.isMission = isMission;
exports.evaluate = evaluate;