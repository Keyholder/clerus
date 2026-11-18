/*\
title: $:/plugins/clerus/core/persistent-reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var barriers = require(
	"$:/plugins/clerus/core/materialization-barrier.js"
);
var continuations = require(
	"$:/plugins/clerus/core/continuations.js"
);
var proposalWork = require(
	"$:/plugins/clerus/core/proposal-work.js"
);
var plannedReactions = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
var observation = require(
	"$:/plugins/clerus/core/observation.js"
);
var reactionEvents = require(
	"$:/plugins/clerus/core/reaction-event.js"
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

function messageEvent(delivery) {
	if (delivery.kind === "notification") {
		return Object.assign({}, delivery.notification, {
			id: delivery.id
		});
	}

	if (delivery.kind === "activation") {
		return {
			type: "tick",
			id: delivery.id
		};
	}

	var event = {
		type: delivery.type,
		id: delivery.id
	};

	if (delivery.type === "report") {
		event.project = delivery.project;
		event.role = delivery.role.slice();
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

	/*
	Reject obsolete ingress explicitly. Silently treating it as
	an independent external event could execute the wrong work.
	*/
	if (
		Object.prototype.hasOwnProperty.call(options, "flow") ||
		Object.prototype.hasOwnProperty.call(options, "deferred")
	) {
		throw new Error("Unsupported persistent delivery address");
	}

	if (
		options.continuation !== undefined &&
		(
			!schemas.isRecord(options.continuation) ||
			typeof options.continuation.title !== "string" ||
			typeof options.continuation.eventId !== "string"
		)
	) {
		throw new Error("Invalid continuation delivery address");
	}

	var manager = continuations.create({
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
	var incomingObligation = null;
	var event = options.event;
	var incoming = options.incoming;

	if (options.continuation !== undefined) {
		incomingObligation = options.continuation.title;

		try {
			var pendingEvent = manager.pending(
				incomingObligation
			).find(function (entry) {
				return entry.id === options.continuation.eventId;
			});

			if (!pendingEvent) {
				return {
					status: "unavailable",
					reason: "continuation-event-not-ready"
				};
			}

			delivery = Object.assign(
				{ id: pendingEvent.id },
				pendingEvent.event
			);

			var recipient = options.store.read(options.title);

			var recipientMatches =
				delivery.recipient.title === options.title &&
				(
					delivery.establishing === true
						? recipient.kind === "absent"
						: recipient.kind === "materialized" &&
							recipient.fields["clerus-executor"] ===
								delivery.recipient.executor
				);

			if (!recipientMatches) {
				return {
					status: "unavailable",
					reason: delivery.establishing === true
						? "establishment-target-occupied"
						: "continuation-recipient-changed"
				};
			}

			event = messageEvent(delivery);
			incoming = delivery.kind === "delivery"
				? delivery.registry
				: undefined;
		} catch (error) {
			return failed(
				"preparation",
				error,
				incomingObligation
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

		var wrappedHandler = function (
			deliveredEvent,
			operational,
			incomingRegistry
		) {
			/*
			Refresh only the delivery view. The authoritative
			notification and its fingerprint stay unchanged.

			A vanished subscription consumes the event through
			successful acceptance of an empty reaction.
			*/
			if (
				delivery !== null &&
				delivery.kind === "notification"
			) {
				var current = observation.refresh(deliveredEvent, {
					store: options.store,
					platform: options.platform
				});

				if (current === null) {
					return;
				}

				deliveredEvent = reactionEvents.prepare({
					event: Object.assign({}, current, {
						id: delivery.id
					}),
					title: options.title,
					platform: options.platform
				});
			}

			invoked = true;

			return options.handler(
				deliveredEvent,
				operational,
				incomingRegistry
			);
		};

		if (delivery !== null && delivery.establishing === true) {
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
			incomingObligation
		);

		if (delivery !== null && invoked) {
			try {
				manager.failEvent(
					incomingObligation,
					delivery.id,
					delivery.recipient,
					error
				);

				failure.pending = [];
			} catch (registrationError) {
				var uncertain = failed(
					"failure-registration",
					registrationError,
					incomingObligation
				);

				uncertain.reactionError = failure.error;
				return uncertain;
			}
		}

		return failure;
	}

	var title = null;

	try {
		if (delivery !== null) {
			title = incomingObligation;

			var accepted = manager.acceptEvent(
				title,
				delivery.id,
				proposal
			);

			if (accepted !== "accepted") {
				return {
					status: "unavailable",
					reason: "incoming-obligation-already-completed"
				};
			}
		} else if (
			proposal.plan.effects.length !== 0 ||
			proposal.plan.messages.length !== 0 ||
			proposal.plan.deferred.length !== 0
		) {
			var work = proposalWork.convert(
				proposal,
				options.newId(),
				options.platform
			);

			title = manager.accept(work);
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
		var results = manager.resume(title);
		var remaining = options.store.read(title);
		var pending = [];

		if (
			remaining.kind === "materialized" &&
			remaining.fields["clerus-custody"] === options.platform
		) {
			pending = manager.pending(title).map(function (entry) {
				return Object.assign(
					{ id: entry.id },
					entry.event
				);
			});
		}

		return {
			status: "completed",
			obligation: title,
			results: results,
			pending: pending
		};
	} catch (error) {
		return failed("materialization", error, title);
	}
}

exports.execute = execute;