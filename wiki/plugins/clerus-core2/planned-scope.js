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
var messageServices = require(
	"$:/plugins/clerus/core2/message-service.js"
);
var messageEffects = require(
	"$:/plugins/clerus/core2/message-effect.js"
);

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
);

function open(options) {
	schemas.assertPlatform(options.platform);

	if (
		options.newId !== undefined &&
		typeof options.newId !== "function"
	) {
		throw new Error("newId must be a function");
	}

	var plan = options.plan;
	plan.assertOpen();

	var initial = plan.read(options.title);
	var establishing = options.establishing === true;
	var space = jobTitles.classify(options.title);
	var executor;
	var registry;

	if (!space) {
		throw new Error("Planned scope requires a job title");
	}

	if (establishing) {
		if (!space.persistent || initial.kind !== "absent") {
			throw new Error(
				"Planned establishment requires an absent persistent target"
			);
		}

		var incoming = schemas.registry(
			options.incoming,
			"incoming"
		);

		var contracts = Object.keys(incoming).filter(function (key) {
			return schemas.formOf(incoming[key]) === "contract";
		});

		if (contracts.length !== 1) {
			throw new Error(
				"Planned establishment requires exactly one contract"
			);
		}

		var contract = incoming[contracts[0]];

		if (contract.temp === true) {
			throw new Error("Contract forbids persistent establishment");
		}

		executor = contract.executor;
		registry = null;
	} else {
		if (
			initial.kind !== "materialized" ||
			initial.fields.type !== "application/json" ||
			typeof initial.fields["clerus-executor"] !== "string" ||
			initial.fields["clerus-executor"].length === 0
		) {
			throw new Error("Planned scope requires an existing JSON job");
		}

		executor = initial.fields["clerus-executor"];

		registry = schemas.registry(
			JSON.parse(initial.fields.text),
			"operational"
		);
	}

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

	function messageEffect(draft, id) {
		if (
			draft.source !== options.title ||
			draft.platform !== options.platform
		) {
			throw new Error("Prepared message belongs to another sender");
		}

		if (draft.establishing !== undefined) {
			throw new Error(
				"Planned establishment is not connected yet"
			);
		}

		var source = activePlan.read(options.title);
		var recipient = activePlan.read(draft.recipient);

		if (
			source.kind !== "materialized" ||
			source.fields["clerus-executor"] !== executor
		) {
			throw new Error("Planned message sender has changed");
		}

		if (
			recipient.kind !== "materialized" ||
			recipient.fields.type !== "application/json" ||
			typeof recipient.fields["clerus-executor"] !== "string" ||
			recipient.fields["clerus-executor"].length === 0
		) {
			throw new Error(
				"Planned message requires a materialized recipient"
			);
		}

		var effect = {
			version: 1,
			kind: "official-message",
			id: id,
			platform: options.platform,
			type: draft.type,

			source: {
				title: options.title,
				executor: executor
			},

			recipient: {
				title: draft.recipient,
				executor: recipient.fields["clerus-executor"]
			},

			registry: draft.registry
		};

		if (draft.type === "report") {
			effect.project = draft.project;
			effect.role = draft.role;
		}

		return messageEffects.validate(effect);
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

	var messageService = messageServices.create({
		title: options.title,
		platform: options.platform,
		readJobs: readJobs,
		resolveReport: project.resolveReport,
		authorizeTransmission: project.authorizeTransmission
	});

	var usedMessageIds = new Set();

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
		},

		prepareOrder: messageService.prepareOrder,
		prepareReport: messageService.prepareReport,

		checkMessage: function (draft) {
			if (typeof options.newId !== "function") {
				throw new Error("Planned sending requires an identity source");
			}

			/*
				Validate support and endpoint binding without allocating
				an identity or changing the plan.
			*/
			messageEffect(draft, "validation-message-identity");
		},

		acceptMessage: function (draft) {
			var id = options.newId();

			var effect = messageEffect(draft, id);

			if (usedMessageIds.has(id)) {
				throw new Error("Message identity source repeated an identity");
			}

			/*
				An allocated identity remains consumed even if this
				operation's branch is subsequently discarded.
			*/
			usedMessageIds.add(id);

			activePlan.send(effect);
		},

		establishOperational: establishing
			? function (registry) {
				if (activePlan.read(options.title).kind !== "absent") {
					throw new Error("Planned establishment target is occupied");
				}

				var normalized = schemas.registry(
					registry,
					"operational"
				);

				activePlan.apply(transitions.transition(
					options.title,
					null,
					{
						title: options.title,
						type: "application/json",
						"clerus-custody": options.platform,
						"clerus-executor": executor,
						text: JSON.stringify(normalized)
					}
				));
			}
			: undefined
	});
}

exports.open = open;