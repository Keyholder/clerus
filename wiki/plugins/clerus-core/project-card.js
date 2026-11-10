/*\
title: $:/plugins/clerus/core/project-card.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var Store = require("$:/plugins/clerus/core/store.js").Store;
var jobState = require("$:/plugins/clerus/core/job-state.js");
var jobView = require("$:/plugins/clerus/core/job-view.js");
var missions = require("$:/plugins/clerus/core/missions.js");
var localCustody = require("$:/plugins/clerus/core/local-custody.js");

var hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);

function roleId(role) {
	return JSON.stringify(role);
}

function read(options) {
	schemas.assertPlatform(options.platform);

	var store = new Store({
		wiki: options.wiki,
		Tiddler: options.Tiddler
	});

	var jobs = jobState.readJobs(function (visit) {
		options.wiki.each(function (tiddler, title) {
			visit(tiddler.fields, title);
		});
	});

	var evaluation = missions.evaluate(jobs);
	var custody = localCustody.create({
		store: store,
		platform: options.platform
	});

	var active = new Map();
	var entries = new Map();
	var holders = new Map();
	var treeRoles = new Set();
	var count = 0;

	evaluation.active.forEach(function (entry) {
		if (entry.project === options.project) {
			active.set(roleId(entry.role), entry);
		}
	});

	evaluation.entries.forEach(function (entry) {
		if (entry.project !== options.project) {
			return;
		}

		var id = roleId(entry.role);

		if (!entries.has(id)) {
			entries.set(id, []);
		}

		entries.get(id).push(entry);
	});

	function holder(title) {
		if (!holders.has(title)) {
			var stored = store.read(title);
			var fields = stored.fields;
			var persistent = title.indexOf("$:/clerus/jobs/") === 0;

			var owned = stored.kind === "materialized" &&
				custody.owns(fields);

			var suspended = fields
				? fields["clerus-suspended"] === "yes"
				: false;

			var assignment = fields
				? fields["clerus-custody"] || "user"
				: null;

			var canResume = (
				persistent &&
				stored.kind === "materialized" &&
				suspended &&
				fields["clerus-custody-transfer"] === undefined &&
				(
					assignment === "user" ||
					assignment === options.platform
				)
			);

			holders.set(title, {
				title: title,
				view: jobView.read(store, title),
				custody: assignment,
				locallyOwned: owned,
				suspended: suspended,
				actions: {
					prepareMove: persistent && owned && !suspended,
					resume: canResume,
					destination: options.platform === "browser"
						? "node"
						: "browser"
				}
			});
		}

		return holders.get(title);
	}

	function node(value, role) {
		count++;
		treeRoles.add(roleId(role));

		var assignment = active.get(roleId(role));
		var result = {
			role: role.slice(),
			task: null,
			error: null,
			assignment: assignment
				? {
					title: assignment.title,
					link: assignment.link,
					holder: holder(assignment.title)
				}
				: null,
			entries: entries.get(roleId(role)) || [],
			children: []
		};

		/*
		A presentation limit, not a claim that deeper data is invalid.
		*/
		if (role.length > 100 || count > 1000) {
			result.error = "Достигнут предел отображения дерева";
			return result;
		}

		if (
			!schemas.isRecord(value) ||
			!hasOwn(value, "task") ||
			!schemas.isRecord(value.parts)
		) {
			result.error = "Некорректный узел дерева задач";
			return result;
		}

		result.task = value.task;

		var segments = Object.keys(value.parts).sort();

		for (var index = 0; index < segments.length; index++) {
			if (count >= 1000) {
				result.error = "Достигнут предел отображения дерева";
				break;
			}

			var segment = segments[index];

			result.children.push(node(
				value.parts[segment],
				role.concat([segment])
			));
		}

		return result;
	}

	var result = {
		project: options.project,
		platform: options.platform,
		projectCustody: null,
		projectLocallyOwned: false,
		error: null,
		tree: null,
		organization: {
			complete: evaluation.complete,
			valid: evaluation.valid,
			issues: evaluation.issues,
			hierarchy: evaluation.hierarchy
		},
		outsideTree: []
	};

	var project = store.read(options.project);

	if (project.kind === "absent") {
		result.error = "Проект не существует";
	} else if (project.fields.type !== "application/json") {
		result.error = "Проект должен иметь тип application/json";
	} else {
		result.projectCustody =
			project.fields["clerus-custody"] || "user";

		result.projectLocallyOwned =
			project.kind === "materialized" &&
			custody.owns(project.fields);

		var parsed;

		try {
			parsed = JSON.parse(project.fields.text);
		} catch (error) {
			result.error = "Некорректный JSON проекта: " + error.message;
		}

		if (!result.error) {
			result.tree = node(parsed, []);
		}
	}

	evaluation.active.forEach(function (entry) {
		if (
			entry.project === options.project &&
			!treeRoles.has(roleId(entry.role))
		) {
			result.outsideTree.push({
				role: entry.role.slice(),
				title: entry.title,
				link: entry.link,
				holder: holder(entry.title)
			});
		}
	});

	return result;
}

exports.read = read;