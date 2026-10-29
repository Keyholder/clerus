/*\
title: $:/plugins/clerus/core/work-plan.js
type: application/javascript
module-type: library
\*/

"use strict";

var effects = require("$:/plugins/clerus/core/effects.js");
var messageEffects =
	require("$:/plugins/clerus/core/message-effect.js");
var deferredEffects =
	require("$:/plugins/clerus/core/deferred-effect.js");
var appointmentEffects =
	require("$:/plugins/clerus/core/appointment-effect.js");

function copy(value) {
	return JSON.parse(JSON.stringify(value));
}

function equal(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function materialize(wiki, Tiddler, plan) {
	if (
		!plan ||
		plan.version !== 1 ||
		!Array.isArray(plan.effects)
	) {
		throw new Error("Invalid work plan");
	}

	if (
		plan.messages !== undefined &&
		!Array.isArray(plan.messages)
	) {
		throw new Error("Invalid work-plan messages");
	}

	if (plan.messages && plan.messages.length > 0) {
		throw new Error("Message-bearing plans require a transactional dispatcher");
	}

	if (
		plan.deferred !== undefined &&
		!Array.isArray(plan.deferred)
	) {
		throw new Error("Invalid deferred plan effects");
	}

	if (plan.deferred && plan.deferred.length > 0) {
		throw new Error("Deferred plans require a transactional dispatcher");
	}

	if (
		plan.appointments !== undefined &&
		(
			!Array.isArray(plan.appointments) ||
			plan.appointments.length > 0
		)
	) {
		throw new Error("Appointment plans require a transactional dispatcher");
	}

	var seen = new Set();

	// Validate every effect before performing any write.
	plan.effects.forEach(function (effect) {
		effects.check(wiki, effect);

		if (seen.has(effect.title)) {
			throw new Error("Work plan contains repeated target titles");
		}

		seen.add(effect.title);
	});

	return plan.effects.map(function (effect) {
		return effects.apply(wiki, Tiddler, effect);
	});
}

function WorkPlan(options) {
	this.source = options.wiki;
	this.Tiddler = options.Tiddler;
	this.baselines = new Map();
	this.virtual = new options.Wiki();
	this.touched = new Map();
	this.creations = new Map();
	this.messages = new Map();
	this.deferred = new Map();
	this.appointments = new Map();
	this.state = "open";
	this.compiled = null;

	this.source.each(function (tiddler, title) {
		var snapshot = effects.capture(tiddler);

		this.baselines.set(title, snapshot);
		this.virtual.addTiddler(new this.Tiddler(snapshot));
	}.bind(this));

	this.view = Object.freeze({
		getTiddler: function (title) {
			this.assertOpen();

			var tiddler = this.virtual.tiddlerExists(title)
				? this.virtual.getTiddler(title)
				: null;

			return tiddler
				? new this.Tiddler(effects.capture(tiddler))
				: undefined;
		}.bind(this),

		tiddlerExists: function (title) {
			this.assertOpen();
			return this.virtual.tiddlerExists(title);
		}.bind(this),

		each: function (callback) {
			this.assertOpen();

			this.virtual.each(function (tiddler, title) {
				callback(
					new this.Tiddler(effects.capture(tiddler)),
					title
				);
			}.bind(this));
		}.bind(this)
	});
}

WorkPlan.prototype.initial = function (title) {
	var snapshot = this.baselines.get(title);

	return snapshot ? copy(snapshot) : null;
};

WorkPlan.prototype.assertOpen = function () {
	if (this.state !== "open") {
		throw new Error("Work plan is not open: " + this.state);
	}
};

WorkPlan.prototype.apply = function (effect) {
	this.assertOpen();

	var serialized = copy(effect);
	var result = effects.apply(this.virtual, this.Tiddler, serialized);

	if (result === "applied" && !this.touched.has(serialized.title)) {
		this.touched.set(serialized.title, serialized.before);
	}

	return result;
};

WorkPlan.prototype.put = function (fields) {
	this.assertOpen();

	var next = new this.Tiddler(fields);
	var title = next.fields.title;

	if (typeof title !== "string" || title.length === 0) {
		throw new Error("Planned tiddler must have a title");
	}

	var current = this.virtual.tiddlerExists(title)
		? this.virtual.getTiddler(title)
		: null;

	return this.apply(effects.put(current, next));
};

WorkPlan.prototype.patch = function (title, changes) {
	this.assertOpen();

	if (!this.virtual.tiddlerExists(title)) {
		throw new Error("Cannot patch an absent materialized tiddler");
	}

	var current = this.virtual.getTiddler(title);

	return this.apply(
		effects.put(current, new this.Tiddler(current, changes))
	);
};

WorkPlan.prototype.remove = function (title) {
	this.assertOpen();

	if (!this.virtual.tiddlerExists(title)) {
		throw new Error("Cannot delete an absent materialized tiddler");
	}

	return this.apply(
		effects.remove(this.virtual.getTiddler(title))
	);
};

WorkPlan.prototype.send = function (effect) {
	this.assertOpen();

	var serialized = copy(effect);

	messageEffects.validate(serialized);

	var previous = this.messages.get(serialized.id);

	if (previous) {
		if (!equal(previous, serialized)) {
			throw new Error("Message identity was reused for a different effect");
		}

		return "already-recorded";
	}

	this.messages.set(serialized.id, serialized);

	return "recorded";
};

WorkPlan.prototype.defer = function (effect) {
	this.assertOpen();

	var serialized = copy(effect);

	deferredEffects.validate(serialized);

	var previous = this.deferred.get(serialized.recipient.title);

	if (previous) {
		if (!equal(previous.recipient, serialized.recipient)) {
			throw new Error("Deferred recipient identity changed within the plan");
		}

		return "already-recorded";
	}

	this.deferred.set(serialized.recipient.title, serialized);

	return "recorded";
};

WorkPlan.prototype.appoint = function (effect) {
	this.assertOpen();

	var serialized = copy(effect);

	appointmentEffects.validate(serialized);

	var title = serialized.recipient.title;

	if (
		this.virtual.tiddlerExists(title) ||
		this.appointments.has(title)
	) {
		throw new Error("Appointment target is already occupied or reserved");
	}

	this.appointments.set(title, serialized);
};

WorkPlan.prototype.cancelAppointment = function (id) {
	this.assertOpen();

	this.appointments.forEach(function (effect, title) {
		if (effect.id === id) {
			this.appointments.delete(title);
		}
	}, this);
};

WorkPlan.prototype.export = function () {
	if (this.state === "aborted") {
		throw new Error("Cannot export an aborted work plan");
	}

	if (this.compiled) {
		return copy(this.compiled);
	}

	this.assertOpen();

	var result = [];

	this.touched.forEach(function (before, title) {
		var current = this.virtual.tiddlerExists(title)
			? this.virtual.getTiddler(title)
			: null;

		var after = effects.capture(current);

		if (equal(before, after)) {
			return;
		}

		var previous = before ? new this.Tiddler(before) : null;

		result.push(
			after
				? effects.put(previous, new this.Tiddler(after))
				: effects.remove(previous)
		);
	}, this);

	return copy({
		version: 1,
		effects: result,
		deferred: Array.from(this.deferred.values()),
		appointments: Array.from(this.appointments.values()),
		messages: Array.from(this.messages.values())
	});
};

WorkPlan.prototype.rememberCreation = function (title, origin) {
	this.assertOpen();

	if (
		!this.touched.has(title) ||
		this.touched.get(title) !== null ||
		!this.virtual.tiddlerExists(title) ||
		this.creations.has(title)
	) {
		throw new Error("Invalid planned creation provenance");
	}

	this.creations.set(title, copy(origin));
};

WorkPlan.prototype.creation = function (title) {
	this.assertOpen();

	var origin = this.creations.get(title);

	return origin ? copy(origin) : null;
};

WorkPlan.prototype.commit = function (materializer) {
	if (this.state !== "open" && this.state !== "failed") {
		throw new Error("Cannot commit work plan: " + this.state);
	}

	if (!this.compiled) {
		this.compiled = this.export();
	}

	this.state = "materializing";

	try {
		var results = materializer
			? materializer(copy(this.compiled))
			: materialize(
				this.source,
				this.Tiddler,
				this.compiled
			);

		this.state = "materialized";
		this.virtual = null;
		this.creations.clear();
		this.messages.clear();
		this.deferred.clear();
		this.appointments.clear();

		return results;
	} catch (error) {
		this.state = "failed";
		throw error;
	}
};

WorkPlan.prototype.abort = function () {
	this.assertOpen();

	this.state = "aborted";
	this.virtual = null;
	this.touched.clear();
	this.creations.clear();
	this.messages.clear();
	this.deferred.clear();
	this.appointments.clear();
};

exports.WorkPlan = WorkPlan;
exports.materialize = materialize;