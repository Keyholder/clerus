/*\
title: $:/plugins/clerus/core2/planned-scope.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var scopes = require("$:/plugins/clerus/core2/scope.js");
var transitions = require("$:/plugins/clerus/core2/store.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");
var jobViews = require("$:/plugins/clerus/core2/job-view.js");
var organizations = require("$:/plugins/clerus/core2/organization.js");
var projectPerspectives = require(
	"$:/plugins/clerus/core2/project-perspective.js"
);

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
);

function open(options) {
	schemas.assertPlatform(options.platform);

	var plan = options.plan;
	plan.assertOpen();

	var initial = plan.read(options.title);

	if (
		!jobTitles.isJobTitle(options.title) ||
		initial.kind !== "materialized" ||
		initial.fields.type !== "application/json" ||
		typeof initial.fields["clerus-executor"] !== "string" ||
		initial.fields["clerus-executor"].length === 0
	) {
		throw new Error("Planned scope requires an existing JSON job");
	}

	var executor = initial.fields["clerus-executor"];

	var registry = schemas.registry(
		JSON.parse(initial.fields.text),
		"operational"
	);

	var activePlan = plan;

	var view = {
		read: function (title) {
			return activePlan.read(title);
		}
	};

	function readJobs() {
		var jobs = [];

		activePlan.each(function (fields, title) {
			if (!jobTitles.isJobTitle(title)) {
				return;
			}

			var parsed = null;

			if (fields.type === "application/json") {
				try {
					var value = JSON.parse(fields.text);

					if (schemas.isRecord(value)) {
						parsed = value;
					}
				} catch (error) {
					// Keep the uninspectable node.
				}
			}

			jobs.push({
				title: title,
				custody: hasOwn(fields, "clerus-custody")
					? fields["clerus-custody"]
					: "user",
				executor: fields["clerus-executor"] === undefined
					? null
					: fields["clerus-executor"],
				registry: parsed
			});
		});

		return jobs;
	}

	function writable() {
		var current = activePlan.read(options.title);

		return current.kind === "materialized" &&
			current.fields.type === "application/json" &&
			current.fields["clerus-executor"] === executor &&
			current.fields["clerus-custody"] === options.platform;
	}

	var organization = organizations.create({
		title: options.title,
		readJobs: readJobs
	});

	var project = projectPerspectives.create({
		title: options.title,
		platform: options.platform,
		store: view,
		readJobs: readJobs
	});

	return scopes.open({
		operational: registry,
		incoming: options.incoming,
		eventType: options.eventType,

		readTiddler: view.read,

		readJob: function (title) {
			return jobViews.read(view, title);
		},

		readMission: project.readMission,
		authorizeMission: project.authorizeMutation,
		authorizeMissionMove: project.authorizeMove,
		authorizeOrganization: organization.authorizeChange,

		canWriteOperational: writable,

		commitOperational: function (before, after) {
			if (!writable()) {
				throw new Error(
					"Planned operational registry is not writable"
				);
			}

			var current = activePlan.read(options.title);

			var stored = schemas.registry(
				JSON.parse(current.fields.text),
				"operational"
			);

			if (
				JSON.stringify(stored) !== JSON.stringify(before)
			) {
				throw new Error(
					"Planned registry diverged from document scope"
				);
			}

			var next = schemas.copyJSON(current.fields);
			next.text = JSON.stringify(after);

			activePlan.apply(transitions.transition(
				options.title,
				current.fields,
				next
			));
		},

		atomicMaterialization: function (perform) {
			return plan.transact(function (branch) {
				activePlan = branch;

				try {
					return perform();
				} finally {
					activePlan = plan;
				}
			});
		}
	});
}

exports.open = open;