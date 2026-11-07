/*\
title: $:/plugins/clerus/core/flow-scheduler.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");

var flowObligations = require(
	"$:/plugins/clerus/core/flow-obligations.js"
);
var persistent = require(
	"$:/plugins/clerus/core/persistent-reaction.js"
);
var localCustody = require(
	"$:/plugins/clerus/core/local-custody.js"
);

function key(title, id) {
	return JSON.stringify([title, id]);
}

function describe(error) {
	return {
		name: String(error && error.name || "Error"),
		message: String(error && error.message || error)
	};
}

function Scheduler(options) {
	schemas.assertPlatform(options.platform);

	this.custody = localCustody.create({
		platform: options.platform
	});

	if (
		!options.store ||
		typeof options.resolveExecutor !== "function" ||
		typeof options.newId !== "function"
	) {
		throw new Error(
			"Flow scheduler requires a store, resolver and identity source"
		);
	}

    if (
        options.onResult !== undefined &&
        typeof options.onResult !== "function"
    ) {
        throw new Error("onResult must be a function");
    }

	if (
		options.executeEphemeral !== undefined &&
		typeof options.executeEphemeral !== "function"
	) {
		throw new Error("executeEphemeral must be a function");
	}

	this.options = options;
	this.queue = new Map();
	this.running = false;

	this.flows = flowObligations.create({
		store: options.store,
		platform: options.platform,
		newId: options.newId
	});
}

Scheduler.prototype.drop = function (title) {
	var removed = [];

	this.queue.forEach(function (work, identity) {
		if (work.title === title) {
			removed.push(identity);
		}
	});

	removed.forEach(function (identity) {
		this.queue.delete(identity);
	}, this);
};

Scheduler.prototype.track = function (title) {
	var stored = this.options.store.read(title);

	if (
		stored.kind !== "materialized" ||
		stored.fields["clerus-custody"] !== this.options.platform
	) {
		this.drop(title);
		return;
	}

	var record = this.flows.read(title).record;

	/*
		The queue is derived. Replace its representation of this
		journal from the current authoritative state.
	*/
	this.drop(title);

	if (record.active !== null) {
		return;
	}

	record.pending.forEach(function (message) {
		this.queue.set(key(title, message.id), {
			title: title,
			id: message.id
		});
	}, this);
};

Scheduler.prototype.deliverEphemeral = function (
	title,
	message,
	handler
) {
	if (typeof this.options.executeEphemeral !== "function") {
		return {
			status: "unavailable",
			reason: "ephemeral-delivery-unavailable"
		};
	}

	var result;

	try {
		result = this.options.executeEphemeral({
			message: schemas.copyJSON(message),
			handler: handler
		});
	} catch (error) {
		return {
			status: "failed",
			phase: "materialization",
			obligation: title,
			error: describe(error)
		};
	}

	if (result.status === "completed") {
		try {
			var completed = this.flows.completeEphemeral(
				title,
				message.id,
				message.recipient
			);

			return {
				status: "completed",
				obligation: title,
				pending: completed.pending
			};
		} catch (error) {
			return {
				status: "failed",
				phase: "acknowledgement",
				obligation: title,
				acceptanceUncertain: !!error.acceptanceUncertain,
				error: describe(error)
			};
		}
	}

	if (
		result.status === "failed" &&
		result.phase === "reaction"
	) {
		try {
			var failed = this.flows.fail(
				title,
				message.id,
				message.recipient,
				result.error
			);

			result.obligation = title;
			result.pending = failed.pending;
		} catch (error) {
			return {
				status: "failed",
				phase: "failure-registration",
				obligation: title,
				acceptanceUncertain: !!error.acceptanceUncertain,
				error: describe(error),
				reactionError: result.error
			};
		}
	}

	return result;
};

Scheduler.prototype.drain = function () {
	if (this.running) {
		throw new Error("Cannot drain a running flow scheduler");
	}

	var report = {
		completed: [],
		blocked: [],
		unavailable: [],
		errors: [],
		remaining: 0
	};

	var attempted = new Set();

	this.running = true;

	try {
		while (true) {
			var selected = null;

			this.queue.forEach(function (work, identity) {
				if (selected === null && !attempted.has(identity)) {
					selected = {
						identity: identity,
						title: work.title,
						id: work.id
					};
				}
			});

			if (selected === null) {
				break;
			}

			attempted.add(selected.identity);

			var message;

			try {
				this.track(selected.title);

				if (!this.queue.has(selected.identity)) {
					continue;
				}

				message = this.flows.pending(selected.title).find(
					function (candidate) {
						return candidate.id === selected.id;
					}
				);

				if (!message) {
					this.queue.delete(selected.identity);
					continue;
				}
			} catch (error) {
				this.drop(selected.title);

				report.errors.push({
					title: selected.title,
					messageId: selected.id,
					phase: "journal",
					error: describe(error)
				});

				continue;
			}

			var recipient = this.options.store.read(
				message.recipient.title
			);

			var space = jobTitles.classify(
				message.recipient.title
			);

			if (!space) {
				report.unavailable.push({
					title: selected.title,
					messageId: selected.id,
					reason: "invalid-recipient-title"
				});

				continue;
			}

			if (
				!space.persistent &&
				space.platform !== this.options.platform
			) {
				report.unavailable.push({
					title: selected.title,
					messageId: selected.id,
					reason: "foreign-ephemeral-recipient"
				});

				continue;
			}

			if (message.establishing === true) {
				if (recipient.kind !== "absent") {
					report.unavailable.push({
						title: selected.title,
						messageId: selected.id,
						reason: "establishment-target-occupied"
					});

					continue;
				}
			} else if (
				recipient.kind !== "materialized" ||
				recipient.fields.type !== "application/json" ||
				recipient.fields["clerus-executor"] !==
					message.recipient.executor
			) {
				report.unavailable.push({
					title: selected.title,
					messageId: selected.id,
					reason: "recipient-unavailable"
				});

				continue;
			}

			if (
				message.establishing !== true &&
				space.persistent &&
				recipient.fields["clerus-suspended"] === "yes" &&
				this.custody.owns(recipient.fields)
			) {
				report.blocked.push({
					title: selected.title,
					messageId: selected.id,
					reason: "resumption-required"
				});

				continue;
			}

			var handler = this.options.resolveExecutor(
				message.recipient.executor
			);

			if (typeof handler !== "function") {
				report.unavailable.push({
					title: selected.title,
					messageId: selected.id,
					reason: "executor-unavailable"
				});

				continue;
			}

			var result;

			if (space.persistent) {
				result = persistent.execute({
					store: this.options.store,
					title: message.recipient.title,
					platform: this.options.platform,
					handler: handler,
					newId: this.options.newId,

					flow: {
						title: selected.title,
						messageId: selected.id
					}
				});
			} else {
				result = this.deliverEphemeral(
					selected.title,
					message,
					handler
				);
			}

            if (typeof this.options.onResult === "function") {
                var deliveredEvent = {
                    type: message.type,
                    id: message.id
                };

                if (message.type === "report") {
                    deliveredEvent.project = message.project;
                    deliveredEvent.role = message.role.slice();
                }

                try {
                    this.options.onResult({
                        title: message.recipient.title,
                        executor: message.recipient.executor,
                        handler: handler,
                        event: deliveredEvent,
                        result: result
                    });
                } catch (error) {
                    result.policyError = describe(error);
                }
            }

			var entry = {
				title: selected.title,
				messageId: selected.id,
				recipient: message.recipient.title,
				result: result
			};

			if (result.status === "completed") {
				report.completed.push(entry);
			} else if (result.status === "blocked") {
				report.blocked.push(entry);
			} else if (result.status === "unavailable") {
				report.unavailable.push(entry);
			} else {
				report.errors.push(entry);
			}

			try {
				this.track(selected.title);
			} catch (error) {
				this.drop(selected.title);

				report.errors.push({
					title: selected.title,
					messageId: selected.id,
					phase: "journal-refresh",
					error: describe(error)
				});
			}
		}
	} finally {
		this.running = false;
		report.remaining = this.queue.size;
	}

	return report;
};

exports.Scheduler = Scheduler;