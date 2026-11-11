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
var flowObligations = require(
	"$:/plugins/clerus/core/flow-obligations.js"
);
var plannedReactions = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
var deferredObligations = require(
	"$:/plugins/clerus/core/deferred-obligations.js"
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
	if (message.kind === "notification") {
		return Object.assign({}, message.notification, {
			id: message.id
		});
	}

	if (message.kind === "activation") {
		return {
			type: "tick",
			id: message.id
		};
	}

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

	var manager = continuations.create({
		store: options.store,
		platform: options.platform,
		newId: options.newId
	});

	var flows = flowObligations.create({
		store: options.store,
		platform: options.platform,
		newId: options.newId
	});

	var deferred = deferredObligations.create({
		store: options.store,
		platform: options.platform
	});

	if (
		[
			options.flow,
			options.deferred,
			options.continuation
		].filter(function (value) {
			return value !== undefined;
		}).length > 1
	) {
		throw new Error(
			"A reaction can consume only one incoming obligation"
		);
	}

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
	var deferredDelivery = false;
	var continuationDelivery = false;
	var incomingObligation = null;
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

		incomingObligation = options.flow.title;
		
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

	if (options.deferred !== undefined) {
		if (
			!options.deferred ||
			typeof options.deferred.title !== "string" ||
			typeof options.deferred.id !== "string"
		) {
			throw new Error("Invalid deferred delivery address");
		}

		incomingObligation = options.deferred.title;

		try {
			var loadedDeferred = deferred.read(incomingObligation);
			var effect = loadedDeferred.effect;
			var deferredOwner = options.store.read(options.title);

			if (
				effect.id !== options.deferred.id ||
				effect.recipient.title !== options.title ||
				deferredOwner.kind !== "materialized" ||
				deferredOwner.fields["clerus-executor"] !==
					effect.recipient.executor
			) {
				return {
					status: "unavailable",
					reason: "deferred-recipient-changed"
				};
			}

			delivery = effect;
			deferredDelivery = true;

			event = {
				type: "tick",
				id: effect.id
			};

			incoming = undefined;
		} catch (error) {
			return failed(
				"preparation",
				error,
				incomingObligation
			);
		}
	}

	if (options.continuation !== undefined) {
		if (
			!options.continuation ||
			typeof options.continuation.title !== "string" ||
			typeof options.continuation.eventId !== "string"
		) {
			throw new Error(
				"Invalid continuation delivery address"
			);
		}

		incomingObligation = options.continuation.title;

		try {
			var pendingEvent = manager.pending(
				incomingObligation
			).find(function (entry) {
				return (
					entry.id === options.continuation.eventId
				);
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

			var recipientMatches = (
				delivery.recipient.title === options.title &&
				(
					delivery.establishing === true
						? recipient.kind === "absent"
						: recipient.kind === "materialized" &&
							recipient.fields["clerus-executor"] ===
								delivery.recipient.executor
				)
			);

			if (!recipientMatches) {
				return {
					status: "unavailable",
					reason: delivery.establishing === true
						? "establishment-target-occupied"
						: "continuation-recipient-changed"
				};
			}

			continuationDelivery = true;
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
			delivery ? incomingObligation : null
		);

		if (delivery && invoked) {
			try {
				if (continuationDelivery) {
					manager.failEvent(
						incomingObligation,
						delivery.id,
						delivery.recipient,
						error
					);

					failure.pending = [];
				} else if (deferredDelivery) {
					deferred.fail(
						incomingObligation,
						delivery.id,
						delivery.recipient,
						error
					);

					failure.pending = [];
				} else {
					var rejected = flows.fail(
						incomingObligation,
						delivery.id,
						delivery.recipient,
						error
					);

					failure.pending = rejected.pending;
				}
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
	var flow = (
		delivery !== null &&
		!continuationDelivery
	);

	try {
		if (delivery) {
			title = incomingObligation;

			var accepted;

			if (continuationDelivery) {
				accepted = manager.acceptEvent(
					title,
					delivery.id,
					proposal
				);
			} else if (deferredDelivery) {
				accepted = deferred.accept(
					title,
					delivery.id,
					proposal
				);
			} else {
				accepted = flows.accept(
					title,
					delivery.id,
					proposal
				);
			}

			if (accepted !== "accepted") {
				return {
					status: "unavailable",
					reason: "incoming-obligation-already-completed"
				};
			}
		} else if (
			proposal.plan.effects.length === 0 &&
			proposal.plan.messages.length === 0 &&
			proposal.plan.deferred.length === 0
		) {
			title = null;
		} else {
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
		if (flow) {
			return {
				status: "completed",
				obligation: title,
				results: [],
				pending: flows.resume(title)
			};
		}

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