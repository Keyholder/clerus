/*\
title: $:/plugins/clerus/core/flow-wal.js
type: application/javascript
module-type: library
\*/

"use strict";

var Wal = require("$:/plugins/clerus/core/wal.js").Wal;
var effects = require("$:/plugins/clerus/core/effects.js");
var workPlans = require("$:/plugins/clerus/core/work-plan.js");
var messageEffects =
	require("$:/plugins/clerus/core/message-effect.js");
var deferredEffects =
	require("$:/plugins/clerus/core/deferred-effect.js");
var deferredWal =
	require("$:/plugins/clerus/core/deferred-wal.js");
var appointmentEffects =
	require("$:/plugins/clerus/core/appointment-effect.js");

function copy(value) {
	return JSON.parse(JSON.stringify(value));
}

function describeError(error) {
	return {
		name: error && error.name ? String(error.name) : "Error",
		message: String(error && error.message || error),
		stack: error && error.stack ? String(error.stack) : null
	};
}

function isRecord(value) {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value);
}

function FlowWal(options) {
	this.wiki = options.wiki;
	this.Tiddler = options.Tiddler;
	this.platform = options.platform;
	this.guard = new Wal(options);
	this.prefix = this.guard.prefix;
}

FlowWal.prototype.read = function (title) {
	var tiddler = this.wiki.getTiddler(title);

	if (
		title.indexOf(this.prefix) !== 0 ||
		!tiddler ||
		tiddler.fields.type !== "application/json" ||
		tiddler.fields["clerus-wal-kind"] !== "flow" ||
		tiddler.fields["clerus-custody"] !== this.platform
	) {
		throw new Error("Flow WAL is not locally owned");
	}

	var record = JSON.parse(tiddler.fields.text);

	if (
		record.version !== 1 ||
		record.kind !== "flow" ||
		record.platform !== this.platform ||
		!Array.isArray(record.pending) ||
		!isRecord(record.seen) ||
		!Array.isArray(record.errors) ||
		(record.active !== null && !isRecord(record.active))
	) {
		throw new Error("Invalid flow WAL");
	}

	return {
		tiddler: tiddler,
		record: record
	};
};

FlowWal.prototype.messagesOf = function (plan) {
	return plan.messages.concat(
		(plan.appointments || []).map(appointmentEffects.message)
	);
};

FlowWal.prototype.checkActive = function (active, seen) {
	if (
		!active ||
		!active.owner ||
		!active.plan ||
		active.plan.version !== 1 ||
		!Array.isArray(active.plan.effects) ||
		!Array.isArray(active.plan.messages)
	) {
		throw new Error("Invalid active flow plan");
	}

	if (
		active.plan.deferred !== undefined &&
		!Array.isArray(active.plan.deferred)
	) {
		throw new Error("Invalid deferred flow effects");
	}

	(active.plan.deferred || []).forEach(function (effect) {
		deferredEffects.validate(effect);

		if (
			effect.recipient.title !== active.owner.title ||
			effect.recipient.executor !== active.owner.executor ||
			effect.recipient.platform !== this.platform
		) {
			throw new Error("Deferred effect must address the reacting owner");
		}
	}, this);

	var statePlan = {
		version: 1,
		effects: copy(active.plan.effects),
		messages: []
	};

	// Reuse existing WAL validation for a message-only reaction.
	var validationPlan = copy(statePlan);

	if (validationPlan.effects.length === 0) {
		var owner = new this.Tiddler(active.owner.state);

		validationPlan.effects.push(effects.put(owner, owner));
	}

	var guarded = {
		version: 1,
		platform: this.platform,
		owner: active.owner,
		plan: validationPlan
	};

	this.guard.validate(guarded);
	this.guard.checkOwner(guarded);
	this.guard.checkCreationTargets(guarded);

	if (
		active.plan.appointments !== undefined &&
		!Array.isArray(active.plan.appointments)
	) {
		throw new Error("Invalid appointment flow effects");
	}

	var appointedTitles = new Set();

	(active.plan.appointments || []).forEach(function (effect) {
		appointmentEffects.validate(effect);

		if (
			effect.source.title !== active.owner.title ||
			effect.source.executor !== active.owner.executor ||
			effect.source.platform !== this.platform ||
			effect.recipient.platform !== this.platform ||
			appointedTitles.has(effect.recipient.title)
		) {
			throw new Error("Invalid appointment origin or repeated target");
		}

		appointedTitles.add(effect.recipient.title);
	}, this);

	var emitted = new Set();

	this.messagesOf(active.plan).forEach(function (message) {
		messageEffects.validate(message);

		if (
			message.source.title !== active.owner.title ||
			message.source.executor !== active.owner.executor ||
			message.source.platform !== this.platform ||
			message.recipient.platform !== this.platform ||
			message.recipient.title.indexOf("$:/clerus/jobs/") !== 0 ||
			emitted.has(message.id)
		) {
			throw new Error("Invalid flow message origin or recipient");
		}

		emitted.add(message.id);

		if (
			Object.prototype.hasOwnProperty.call(seen, message.id) &&
			JSON.stringify(seen[message.id]) !== JSON.stringify(message)
		) {
			throw new Error("Flow message identity was reused");
		}
	}, this);

	return statePlan;
};

FlowWal.prototype.write = function (tiddler, record, custody) {
	effects.apply(
		this.wiki,
		this.Tiddler,
		effects.put(tiddler, new this.Tiddler(tiddler, {
			"clerus-custody": custody || this.platform,
			text: JSON.stringify(record)
		}))
	);
};

FlowWal.prototype.register = function (job, ownerState, plan) {
	if (
		!job.persistent ||
		job.title.indexOf("$:/clerus/jobs/") !== 0
	) {
		throw new Error("Flow requires a persistent source");
	}

	var record = {
		version: 1,
		kind: "flow",
		platform: this.platform,
		active: {
			owner: {
				title: job.title,
				executor: job.executor,
				state: ownerState
			},
			plan: plan
		},
		pending: [],
		seen: {},
		errors: []
	};

	record = copy(record);

	this.checkActive(record.active, record.seen);

	if (
		record.active.plan.effects.length === 0 &&
		record.active.plan.messages.length === 0 &&
		(record.active.plan.appointments || []).length === 0 &&
		(record.active.plan.deferred || []).length === 0
	) {
		throw new Error("Cannot register an empty flow");
	}

	var title = this.guard.allocate();

	effects.apply(
		this.wiki,
		this.Tiddler,
		effects.put(null, new this.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": this.platform,
			"clerus-wal-kind": "flow",
			text: JSON.stringify(record)
		}))
	);

	return title;
};

FlowWal.prototype.resume = function (title) {
	var loaded = this.read(title);
	var record = loaded.record;

	if (record.active) {
		var active = record.active;

		try {
			var statePlan = this.checkActive(active, record.seen);

			workPlans.materialize(this.wiki, this.Tiddler, statePlan);

			(active.plan.appointments || []).forEach(function (effect) {
				appointmentEffects.materialize(
					this.wiki,
					this.Tiddler,
					effect
				);
			}, this);

			(active.plan.deferred || []).forEach(function (effect) {
				deferredWal.record(this, effect);
			}, this);

			this.messagesOf(active.plan).forEach(function (message) {
				if (
					Object.prototype.hasOwnProperty.call(
						record.seen, message.id
					)
				) {
					return;
				}

				Object.defineProperty(record.seen, message.id, {
					value: copy(message),
					enumerable: true,
					writable: true,
					configurable: true
				});

				record.pending.push(copy(message));
			});
		} catch (error) {
			// The accepted plan remains authoritative in the WAL.
			// Do not turn an interrupted materialization into a
			// completed branch failure, and do not clear active.
			try {
				this.guard.pause(title, error);
			} catch (pauseError) {
				// Failure to store the diagnostic must not hide the
				// original materialization failure.
				error.pauseError = describeError(pauseError);
			}

			error.walTitle = title;
			throw error;
		}

		record.active = null;
	}

	if (record.pending.length === 0 && record.errors.length === 0) {
		effects.apply(
			this.wiki,
			this.Tiddler,
			effects.remove(loaded.tiddler)
		);

		return [];
	}

	this.write(
		loaded.tiddler,
		record,
		record.pending.length === 0 ? "user" : this.platform
	);

	return copy(record.pending);
};

FlowWal.prototype.accept = function (
	title,
	messageId,
	job,
	ownerState,
	plan
) {
	var loaded = this.read(title);
	var record = loaded.record;

	if (record.active) {
		throw new Error("Flow already has an active materialization");
	}

	var index = record.pending.findIndex(function (message) {
		return message.id === messageId;
	});

	if (index === -1) {
		if (Object.prototype.hasOwnProperty.call(record.seen, messageId)) {
			return "already-completed";
		}

		throw new Error("Unknown flow message");
	}

	var message = record.pending[index];

	messageEffects.validate(message);

	if (
		!job.persistent ||
		message.recipient.title !== job.title ||
		message.recipient.executor !== job.executor ||
		message.recipient.platform !== this.platform
	) {
		throw new Error("Message was accepted by the wrong recipient");
	}

	var active = copy({
		owner: {
			title: job.title,
			executor: job.executor,
			state: ownerState
		},
		plan: plan
	});

	this.checkActive(active, record.seen);

	record.pending.splice(index, 1);
	record.active = active;

	this.write(loaded.tiddler, record);

	return "accepted";
};

FlowWal.prototype.pending = function (title) {
	var record = this.read(title).record;

	return record.active ? [] : copy(record.pending);
};

FlowWal.prototype.recover = function () {
	var titles = [];

	this.wiki.each(function (tiddler, title) {
		if (
			title.indexOf(this.prefix) === 0 &&
			tiddler.fields["clerus-wal-kind"] === "flow"
		) {
			titles.push(title);
		}
	}.bind(this));

	return titles.sort().map(function (title) {
		var tiddler = this.wiki.getTiddler(title);

		if (tiddler.fields["clerus-custody"] !== this.platform) {
			return { title: title, status: "paused", messages: [] };
		}

		try {
			var messages = this.resume(title);
			var remaining = this.wiki.getTiddler(title);

			return {
				title: title,
				status: !remaining
					? "closed"
					: remaining.fields["clerus-custody"] === "user"
						? "paused"
						: "pending",
				messages: messages
			};
		} catch (error) {
			this.guard.pause(title, error);

			return {
				title: title,
				status: "failed",
				messages: [],
				error: describeError(error)
			};
		}
	}, this);
};

FlowWal.prototype.failMessage = function (
	title,
	messageId,
	job,
	error
) {
	var loaded = this.read(title);
	var record = loaded.record;

	if (record.active) {
		throw new Error("Cannot reject a message during active materialization");
	}

	var index = record.pending.findIndex(function (message) {
		return message.id === messageId;
	});

	if (index === -1) {
		throw new Error("Unknown pending flow message");
	}

	var message = record.pending[index];

	if (
		message.recipient.title !== job.title ||
		message.recipient.executor !== job.executor ||
		message.recipient.platform !== this.platform
	) {
		throw new Error("Message failure belongs to another recipient");
	}

	record.pending.splice(index, 1);

	record.errors.push({
		owner: {
			title: job.title,
			executor: job.executor
		},
		message: message,
		error: error
	});

	this.write(loaded.tiddler, record);

	return this.resume(title);
};

exports.FlowWal = FlowWal;