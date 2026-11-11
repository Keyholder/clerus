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
var messageEffects = require(
	"$:/plugins/clerus/core/message-effect.js"
);
var deferredEffects = require(
	"$:/plugins/clerus/core/deferred-effect.js"
);
var jobState = require("$:/plugins/clerus/core/job-state.js");
var reactionServices = require(
	"$:/plugins/clerus/core/reaction-services.js"
);
var establishmentInput = require(
	"$:/plugins/clerus/core/establishment-input.js"
);
var localCustody = require(
	"$:/plugins/clerus/core/local-custody.js"
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

		var founding = establishmentInput.read(options.incoming, {
			temporary: false,
			countError:
				"Planned establishment requires exactly one contract"
		});

		var contract = founding.contract;

		executor = contract.executor;
		registry = null;
	} else {
		if (
			initial.kind !== "materialized" ||
			!jobState.hasExecutionHeader(initial.fields)
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
		},

		apply: function (effect) {
			return activePlan.apply(effect);
		}
	};

	var custody = localCustody.create({
		platform: options.platform,
		store: view
	});

	function readJobs() {
		return jobState.readJobs(function (visit) {
			activePlan.each(visit);
		});
	}

	function writable() {
		var current = activePlan.read(options.title);

		return current.kind === "materialized" &&
			current.fields.type === "application/json" &&
			current.fields["clerus-executor"] === executor &&
			custody.owns(current.fields);
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
				!jobState.hasExecutionHeader(recipient.fields)
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

	var services = reactionServices.create({
		title: options.title,
		platform: options.platform,
		store: view,
		readJobs: readJobs,
		newId: options.newId
	});

	var usedEffectIds = new Set();

	return scopes.open(Object.assign({}, services, {
		operational: registry,
		incoming: options.incoming,
		eventType: options.eventType,

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
	}));
}

exports.open = open;