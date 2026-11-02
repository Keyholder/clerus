/*\
title: $:/plugins/clerus/core2/persistent-reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");

var barriers = require(
	"$:/plugins/clerus/core2/materialization-barrier.js"
);
var obligations = require(
	"$:/plugins/clerus/core2/obligations.js"
);
var flowObligations = require(
	"$:/plugins/clerus/core2/flow-obligations.js"
);
var plannedReactions = require(
	"$:/plugins/clerus/core2/planned-reaction.js"
);

function describe(error) {
	return {
		name: String(error && error.name || "Error"),
		message: String(error && error.message || error),
		stack: error && error.stack ? String(error.stack) : null
	};
}

function failed(phase, error, title) {
	return {
		status: "failed",
		phase: phase,
		obligation: title || null,
		acceptanceUncertain: !!(
			error && error.acceptanceUncertain
		),
		error: describe(error)
	};
}

function messageEvent(message) {
	var event = {
		type: message.type,
		id: message.id
	};

	if (message.type === "report") {
		event.project = message.project;
		event.role = message.role.slice();
	}

	return event;
}

function execute(options) {
	schemas.assertPlatform(options.platform);

	var space = jobTitles.classify(options.title);

	if (
		!space ||
		!space.persistent ||
		typeof options.handler !== "function" ||
		typeof options.newId !== "function"
	) {
		throw new Error(
			"Persistent execution requires a job, handler and identity source"
		);
	}

	var manager = obligations.create({
		store: options.store,
		platform: options.platform,
		newId: options.newId
	});

	var flows = flowObligations.create({
		store: options.store,
		platform: options.platform,
		newId: options.newId
	});

	var blockers = barriers.collect({
		store: options.store
	}).forJob(options.title);

	if (blockers.length > 0) {
		return {
			status: "blocked",
			obligations: blockers
		};
	}

	var delivery = null;
	var event = options.event;
	var incoming = options.incoming;

	if (options.flow !== undefined) {
		if (
			!options.flow ||
			typeof options.flow.title !== "string" ||
			typeof options.flow.messageId !== "string"
		) {
			throw new Error("Invalid flow delivery address");
		}

		try {
			delivery = flows.pending(options.flow.title).find(
				function (message) {
					return message.id === options.flow.messageId;
				}
			);

			if (!delivery) {
				return {
					status: "unavailable",
					reason: "flow-message-not-pending"
				};
			}

			var current = options.store.read(options.title);
			var establishing = delivery.establishing === true;

			var recipientMatches = delivery.recipient.title === options.title &&
				(
					establishing
						? current.kind === "absent"
						: current.kind === "materialized" &&
							current.fields["clerus-executor"] ===
								delivery.recipient.executor
				);

			if (!recipientMatches) {
				return {
					status: "unavailable",
					reason: establishing
						? "establishment-target-occupied"
						: "flow-recipient-changed"
				};
			}

			event = messageEvent(delivery);
			incoming = delivery.registry;
		} catch (error) {
			return failed(
				"preparation",
				error,
				options.flow.title
			);
		}
	}

	var proposal;
	var invoked = false;

	try {
		var execution = {
			store: options.store,
			title: options.title,
			platform: options.platform,
			event: event,
			incoming: incoming,
			newId: options.newId,
			acknowledgeResumption:
				options.acknowledgeResumption === true
		};

		var wrappedHandler = function (event, operational, incoming) {
			invoked = true;

			return options.handler(
				event,
				operational,
				incoming
			);
		};

		if (delivery && delivery.establishing === true) {
			execution.resolveExecutor = function (name) {
				if (name !== delivery.recipient.executor) {
					throw new Error(
						"Establishment executor does not match the message"
					);
				}

				return wrappedHandler;
			};

			proposal = plannedReactions.establish(execution);
		} else {
			execution.handler = wrappedHandler;
			proposal = plannedReactions.execute(execution);
		}
	} catch (error) {
		var failure = failed(
			invoked ? "reaction" : "preparation",
			error,
			delivery ? options.flow.title : null
		);

		/*
			Only an actual failed reaction completes a branch
			with an error. An unavailable preparation preserves
			the pending message.
		*/
		if (delivery && invoked) {
			try {
				var rejected = flows.fail(
					options.flow.title,
					delivery.id,
					delivery.recipient,
					error
				);

				failure.pending = rejected.pending;
			} catch (registrationError) {
				var uncertain = failed(
					"failure-registration",
					registrationError,
					options.flow.title
				);

				uncertain.reactionError = failure.error;
				return uncertain;
			}
		}

		return failure;
	}

	var title = null;
	var flow = delivery !== null;

	try {
		if (delivery) {
			title = options.flow.title;

			var accepted = flows.accept(
				title,
				delivery.id,
				proposal
			);

			if (accepted !== "accepted") {
				return {
					status: "unavailable",
					reason: "flow-message-already-completed"
				};
			}
		} else if (proposal.plan.messages.length > 0) {
			flow = true;
			title = flows.register(proposal);
		} else {
			title = manager.accept(proposal);
		}
	} catch (error) {
		return failed(
			"acceptance",
			error,
			error && error.obligationTitle
				? error.obligationTitle
				: title
		);
	}

	if (title === null) {
		return {
			status: "completed",
			obligation: null,
			results: [],
			pending: []
		};
	}

	try {
		if (flow) {
			return {
				status: "completed",
				obligation: title,
				results: [],
				pending: flows.resume(title)
			};
		}

		return {
			status: "completed",
			obligation: title,
			results: manager.resume(title),
			pending: []
		};
	} catch (error) {
		return failed("materialization", error, title);
	}
}

exports.execute = execute;