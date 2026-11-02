/*\
title: $:/plugins/clerus/core/planned-scope.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var scopes = require("$:/plugins/clerus/core/scope.js");
var transitions = require("$:/plugins/clerus/core/store.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var jobViews = require("$:/plugins/clerus/core/job-view.js");
var organizations = require("$:/plugins/clerus/core/organization.js");
var projectPerspectives = require(
	"$:/plugins/clerus/core/project-perspective.js"
);
var messageServices = require(
	"$:/plugins/clerus/core/message-service.js"
);
var messageEffects = require(
	"$:/plugins/clerus/core/message-effect.js"
);
var titleIssuers = require(
	"$:/plugins/clerus/core/title-issuer.js"
);
var deferredEffects = require(
	"$:/plugins/clerus/core/deferred-effect.js"
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

	var titleIssuer = options.newId
		? titleIssuers.create({
			title: options.title,
			store: view,
			newId: options.newId,
			platform: options.platform
		})
		: null;

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

		var source = activePlan.read(options.title);

		if (
			source.kind !== "materialized" ||
			source.fields["clerus-executor"] !== executor
		) {
			throw new Error("Planned message sender has changed");
		}

		var recipient = activePlan.read(draft.recipient);
		var recipientExecutor;

		if (draft.establishing === true) {
			if (recipient.kind !== "absent") {
				throw new Error("Planned establishment target is occupied");
			}

			var reserved = activePlan.export().messages.some(
				function (message) {
					return message.establishing === true &&
						message.recipient.title === draft.recipient;
				}
			);

			if (reserved) {
				throw new Error(
					"Plan already contains establishment for this target"
				);
			}

			recipientExecutor = draft.executor;
		} else {
			if (draft.establishing !== undefined) {
				throw new Error("Invalid establishment marker");
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

			recipientExecutor = recipient.fields["clerus-executor"];
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
				executor: recipientExecutor
			},

			registry: draft.registry
		};

		if (draft.establishing === true) {
			effect.establishing = true;
		}

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

	var usedEffectIds = new Set();

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

			if (usedEffectIds.has(id)) {
				throw new Error("Message identity source repeated an identity");
			}

			/*
				An allocated identity remains consumed even if this
				operation's branch is subsequently discarded.
			*/
			usedEffectIds.add(id);

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
			: undefined,

		issueJobTitle: titleIssuer
			? titleIssuer.issue
			: undefined,

		checkDeferred: function () {
			if (typeof options.newId !== "function") {
				throw new Error("Planned deferral requires an identity source");
			}

			var current = activePlan.read(options.title);

			if (
				current.kind !== "materialized" ||
				current.fields["clerus-executor"] !== executor
			) {
				throw new Error("Deferred recipient has changed");
			}
		},

		acceptDeferred: function () {
			var effect = deferredEffects.validate({
				version: 1,
				kind: "deferred-event",
				id: options.newId(),
				platform: options.platform,

				recipient: {
					title: options.title,
					executor: executor
				}
			});

			if (usedEffectIds.has(effect.id)) {
				throw new Error("Effect identity source repeated an identity");
			}

			usedEffectIds.add(effect.id);
			activePlan.defer(effect);
		}
	});
}

exports.open = open;