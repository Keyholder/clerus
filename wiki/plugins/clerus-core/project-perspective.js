/*\
title: $:/plugins/clerus/core/project-perspective.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var missionSchema = require(
	"$:/plugins/clerus/core/mission-schema.js"
);
var missions = require("$:/plugins/clerus/core/missions.js");
var tasks = require("$:/plugins/clerus/core/project-tasks.js");
var roles = require("$:/plugins/clerus/core/roles.js");
var jobTitles = require(
	"$:/plugins/clerus/core/job-titles.js"
);
var jobState = require("$:/plugins/clerus/core/job-state.js");
var localCustody = require(
	"$:/plugins/clerus/core/local-custody.js"
);

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

function matches(entry, title, document) {
	return entry.title === title &&
		entry.project === document.project &&
		entry.link === document.link &&
		JSON.stringify(entry.role) ===
			JSON.stringify(document.role);
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

	function readScope(scope) {
		if (
			!schemas.isRecord(scope) ||
			!Array.isArray(scope.outgoing)
		) {
			throw new Error("Invalid document scope snapshot");
		}

		var operational = scope.operational === null
			? null
			: schemas.registry(
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

		return {
			operational: operational,
			transactional: transactional,
			available: operational === null
				? transactional.slice()
				: [operational].concat(transactional)
		};
	}

	function contains(context, document) {
		var identity = missionSchema.identity(document);
		var signature = missionSchema.delegationSignature(document);

		return context.available.some(function (registry) {
			return Object.keys(registry).some(function (key) {
				var candidate = registry[key];

				return schemas.isRecord(candidate) &&
					candidate.form === "mission" &&
					missionSchema.identity(candidate) === identity &&
					missionSchema.delegationSignature(candidate) === signature;
			});
		});
	}

	function evaluateContext(context) {
		var stored = options.store.read(options.title);

		if (stored.kind !== "materialized") {
			return null;
		}

		var perspective = jobState.overlayOwner(
			options.readJobs(),
			options.title,
			context.operational
		);

		var owner = perspective.owner;

		/*
		Keep the available registries intact. Synthetic entries
		belong only to the evaluator's private owner projection.
		*/

		owner.custody = hasOwn(stored.fields, "clerus-custody")
			? stored.fields["clerus-custody"]
			: "user";

		var sequence = 0;

		context.transactional.forEach(function (registry) {
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

				define(
					owner.registry,
					synthetic,
					missionSchema.validate(candidate)
				);
			});
		});

		return missions.evaluate(perspective.jobs);
	}

	function inspectAssignment(value, scope) {
		var document = missionSchema.validate(value);
		var context = readScope(scope);

		if (!contains(context, document)) {
			return {
				document: document,
				evaluation: null,
				active: false,
				reason: "Mission is not available in this scope"
			};
		}

		if (context.operational === null) {
			return {
				document: document,
				evaluation: null,
				active: false,
				reason: "Mission owner is not established in this scope"
			};
		}

		var evaluation = evaluateContext(context);

		if (evaluation === null) {
			return {
				document: document,
				evaluation: null,
				active: false,
				reason: "Mission owner is not materialized"
			};
		}

		var active = evaluation.active.find(function (entry) {
			return matches(entry, options.title, document);
		});

		if (active) {
			return {
				document: document,
				evaluation: evaluation,
				active: true,
				reason: null
			};
		}

		var recorded = evaluation.entries.find(function (entry) {
			return matches(entry, options.title, document);
		});

		return {
			document: document,
			evaluation: evaluation,
			active: false,
			reason: recorded && recorded.reason
				? recorded.reason
				: "Inactive mission"
		};
	}

	function readMission(value, scope) {
		var assignment = inspectAssignment(value, scope);

		if (!assignment.active) {
			return unavailable(assignment.reason);
		}

		var result = {
			active: true,
			readable: false,
			task: null,
			reason: null
		};

		var document = assignment.document;
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
				throw new Error(
					"Project must have type application/json"
				);
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

	function authorizeMutation(value, scope, operation, segment) {
		if (operation !== "issue" && operation !== "revoke") {
			throw new Error("Unsupported mission mutation");
		}

		if (!roles.isSegment(segment)) {
			throw new Error("Invalid child role segment");
		}

		var assignment = inspectAssignment(value, scope);

		if (!assignment.active) {
			throw new Error(assignment.reason);
		}

		if (operation === "revoke") {
			return;
		}

		schemas.assertPlatform(options.platform);

		var custody = localCustody.create({
			platform: options.platform
		});

		var document = assignment.document;
		var project = options.store.read(document.project);

		if (project.kind !== "materialized") {
			throw new Error(
				"Issuance requires a materialized project"
			);
		}

		if (!custody.owns(project.fields)) {
			throw new Error("Project is not owned by this platform");
		}

		if (project.fields.type !== "application/json") {
			throw new Error(
				"Project must have type application/json"
			);
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

		var assignment = inspectAssignment(document, scope);

		if (!assignment.active) {
			throw new Error(assignment.reason);
		}

		var parentRole = document.role.slice(0, -1);

		var parent = assignment.evaluation.active.find(
			function (entry) {
				return entry.project === document.project &&
					JSON.stringify(entry.role) ===
						JSON.stringify(parentRole);
			}
		);

		if (!parent) {
			throw new Error(
				"Report has no active parent assignment"
			);
		}

		if (parent.title === options.title) {
			throw new Error(
				"Report requires a distinct parent holder"
			);
		}

		return {
			recipient: parent.title,
			project: document.project,
			role: document.role.slice()
		};
	}

	function authorizeMove(value, scope) {
		var assignment = inspectAssignment(value, scope);

		if (!assignment.active) {
			throw new Error(assignment.reason);
		}
	}

	function authorizeTransmission(type, value, scope, addressing) {
		var assignment = inspectAssignment(value, scope);
		var document = assignment.document;

		if (!assignment.active) {
			throw new Error(assignment.reason);
		}

		if (document.role.length === 0) {
			throw new Error("Root mission cannot be transmitted");
		}

		if (type === "report") {
			if (
				!addressing ||
				missionSchema.identity(addressing) !==
					missionSchema.identity(document)
			) {
				throw new Error(
					"A report can transmit only its addressing mission"
				);
			}

			return;
		}

		if (type !== "order") {
			throw new Error("Unsupported mission transmission");
		}

		var parentRole = document.role.slice(0, -1);

		var parent = assignment.evaluation.active.find(function (entry) {
			return entry.title === options.title &&
				entry.project === document.project &&
				JSON.stringify(entry.role) === JSON.stringify(parentRole);
		});

		if (!parent) {
			throw new Error(
				"Order sender must hold the active immediate parent mission"
			);
		}

		var operational = schemas.registry(
			scope.operational,
			"operational"
		);

		var retained = Object.keys(operational).some(function (key) {
			var candidate = operational[key];

			return schemas.isRecord(candidate) &&
				candidate.form === "mission" &&
				candidate.project === parent.project &&
				candidate.link === parent.link &&
				JSON.stringify(candidate.role) ===
					JSON.stringify(parent.role);
		});

		if (!retained) {
			throw new Error(
				"Order sender must retain the parent mission operationally"
			);
		}
	}

	return Object.freeze({
		readMission: readMission,
		authorizeMutation: authorizeMutation,
		resolveReport: resolveReport,
		authorizeMove: authorizeMove,
		authorizeTransmission: authorizeTransmission
	});
}

exports.create = create;