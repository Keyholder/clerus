/*\
title: $:/plugins/clerus/core2/project-perspective.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var missionSchema = require(
	"$:/plugins/clerus/core2/mission-schema.js"
);
var missions = require("$:/plugins/clerus/core2/missions.js");
var tasks = require("$:/plugins/clerus/core2/project-tasks.js");
var jobTitles = require(
	"$:/plugins/clerus/core2/job-titles.js"
);
var roles = require("$:/plugins/clerus/core2/roles.js");

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
);

function define(record, key, value) {
	Object.defineProperty(record, key, {
		value: value,
		enumerable: true,
		writable: true,
		configurable: true
	});
}

function unavailable(reason) {
	return {
		active: false,
		readable: false,
		task: null,
		reason: reason
	};
}

function create(options) {
	if (!jobTitles.isJobTitle(options.title)) {
		throw new Error("Project perspective requires a job title");
	}

	if (
		!options.store ||
		typeof options.store.read !== "function" ||
		typeof options.readJobs !== "function"
	) {
		throw new Error("Project perspective requires state readers");
	}

	function readMission(value, scope) {
		var document = missionSchema.validate(value);

		if (
			!schemas.isRecord(scope) ||
			!Array.isArray(scope.outgoing)
		) {
			throw new Error("Invalid document scope snapshot");
		}

		var operational = schemas.registry(
			scope.operational,
			"operational"
		);

		var transactional = [];

		if (scope.incoming !== null) {
			transactional.push(
				schemas.registry(scope.incoming, "incoming")
			);
		}

		scope.outgoing.forEach(function (registry) {
			transactional.push(
				schemas.registry(registry, "outgoing")
			);
		});

		var available = [operational].concat(transactional);
		var identity = missionSchema.identity(document);
		var signature = missionSchema.delegationSignature(document);

		var held = available.some(function (registry) {
			return Object.keys(registry).some(function (key) {
				var candidate = registry[key];

				return schemas.isRecord(candidate) &&
					candidate.form === "mission" &&
					missionSchema.identity(candidate) === identity &&
					missionSchema.delegationSignature(candidate) === signature;
			});
		});

		if (!held) {
			return unavailable("Mission is not available in this scope");
		}

		var storedOwner = options.store.read(options.title);

		if (storedOwner.kind !== "materialized") {
			return unavailable("Mission owner is not materialized");
		}

		var jobs = schemas.copyJSON(options.readJobs());

		if (!Array.isArray(jobs)) {
			throw new Error("Job reader must return an array");
		}

		var owners = jobs.filter(function (job) {
			return job.title === options.title;
		});

		if (owners.length !== 1) {
			throw new Error("Perspective requires exactly one owner snapshot");
		}

		var owner = owners[0];

		owner.registry = operational;
		owner.custody = hasOwn(storedOwner.fields, "clerus-custody")
			? storedOwner.fields["clerus-custody"]
			: "user";

		/*
		Only mission objects are added from transactional registries.
		Their title documents must not become organizational edges.
		*/
		var sequence = 0;

		transactional.forEach(function (registry) {
			Object.keys(registry).sort().forEach(function (key) {
				var candidate = registry[key];

				if (
					!schemas.isRecord(candidate) ||
					candidate.form !== "mission"
				) {
					return;
				}

				var synthetic;

				do {
					sequence++;
					synthetic = "@scope-mission-" + sequence;
				} while (hasOwn(owner.registry, synthetic));

				define(owner.registry, synthetic, candidate);
			});
		});

		var evaluation = missions.evaluate(jobs);

		var active = evaluation.active.find(function (entry) {
			return entry.title === options.title &&
				entry.project === document.project &&
				entry.link === document.link &&
				JSON.stringify(entry.role) ===
					JSON.stringify(document.role);
		});

		if (!active) {
			var recorded = evaluation.entries.find(function (entry) {
				return entry.title === options.title &&
					entry.project === document.project &&
					entry.link === document.link &&
					JSON.stringify(entry.role) ===
						JSON.stringify(document.role);
			});

			return unavailable(
				recorded && recorded.reason
					? recorded.reason
					: "Inactive mission"
			);
		}

		var result = {
			active: true,
			readable: false,
			task: null,
			reason: null
		};

		var project = options.store.read(document.project);

		if (project.kind === "absent") {
			result.reason = "Project does not exist";
			return result;
		}

		try {
			if (
				!project.fields ||
				project.fields.type !== "application/json"
			) {
				throw new Error("Project must have type application/json");
			}

			result.task = tasks.resolve(
				JSON.parse(project.fields.text),
				document.role
			);

			result.readable = true;
		} catch (error) {
			result.reason = String(error.message);
		}

		return result;
	}

	function authorizeMutation(document, scope, operation, segment) {
		if (operation !== "issue" && operation !== "revoke") {
			throw new Error("Unsupported mission mutation");
		}

		if (!roles.isSegment(segment)) {
			throw new Error("Invalid child role segment");
		}

		var view = readMission(document, scope);

		if (!view.active) {
			throw new Error(view.reason || "Inactive mission");
		}

		if (operation === "revoke") {
			return;
		}

		schemas.assertPlatform(options.platform);

		var project = options.store.read(document.project);

		if (project.kind !== "materialized") {
			throw new Error("Issuance requires a materialized project");
		}

		if (
			project.fields["clerus-custody"] !== options.platform
		) {
			throw new Error("Project is not owned by this platform");
		}

		if (project.fields.type !== "application/json") {
			throw new Error("Project must have type application/json");
		}

		tasks.resolve(
			JSON.parse(project.fields.text),
			document.role.concat([segment])
		);
	}

	function resolveReport(value, scope) {
		var document = missionSchema.validate(value);

		if (document.role.length === 0) {
			throw new Error("Root mission cannot address a report");
		}

		var view = readMission(document, scope);

		if (!view.active) {
			throw new Error(view.reason || "Inactive mission");
		}

		var jobs = schemas.copyJSON(options.readJobs());

		if (!Array.isArray(jobs)) {
			throw new Error("Job reader must return an array");
		}

		var owners = jobs.filter(function (job) {
			return job.title === options.title;
		});

		if (owners.length !== 1) {
			throw new Error(
				"Report requires exactly one owner snapshot"
			);
		}

		var owner = owners[0];
		var stored = options.store.read(options.title);

		if (stored.kind !== "materialized") {
			throw new Error("Report owner is not materialized");
		}

		owner.registry = schemas.registry(
			scope.operational,
			"operational"
		);

		owner.custody = hasOwn(stored.fields, "clerus-custody")
			? stored.fields["clerus-custody"]
			: "user";

		var transactional = scope.outgoing.slice();

		if (scope.incoming !== null) {
			transactional.unshift(scope.incoming);
		}

		var sequence = 0;

		transactional.forEach(function (registry) {
			Object.keys(registry).forEach(function (key) {
				var candidate = registry[key];

				if (
					!schemas.isRecord(candidate) ||
					candidate.form !== "mission"
				) {
					return;
				}

				var synthetic;

				do {
					sequence++;
					synthetic = "@report-mission-" + sequence;
				} while (hasOwn(owner.registry, synthetic));

				define(
					owner.registry,
					synthetic,
					missionSchema.validate(candidate)
				);
			});
		});

		var evaluation = missions.evaluate(jobs);
		var parentRole = document.role.slice(0, -1);

		var parent = evaluation.active.find(function (entry) {
			return entry.project === document.project &&
				JSON.stringify(entry.role) === JSON.stringify(parentRole);
		});

		if (!parent) {
			throw new Error("Report has no active parent assignment");
		}

		if (parent.title === options.title) {
			throw new Error("Report requires a distinct parent holder");
		}

		return {
			recipient: parent.title,
			project: document.project,
			role: document.role.slice()
		};
	}

	return Object.freeze({
		readMission: readMission,
		authorizeMutation: authorizeMutation,
		resolveReport: resolveReport
	});
}

exports.create = create;