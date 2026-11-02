/*\
title: $:/plugins/clerus/core/plan.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var transitions = require("$:/plugins/clerus/core/store.js");
var messageEffects = require(
	"$:/plugins/clerus/core/message-effect.js"
);
var deferredEffects = require(
	"$:/plugins/clerus/core/deferred-effect.js"
);

function equal(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function normalize(fields) {
	if (!schemas.isRecord(fields)) {
		throw new Error("Plan snapshot requires field records");
	}

	return transitions.transition(
		fields.title,
		fields,
		fields
	).after;
}

function load(records, description) {
	if (!Array.isArray(records)) {
		throw new Error("Invalid " + description + " snapshot");
	}

	var result = new Map();

	records.forEach(function (fields) {
		var normalized = normalize(fields);

		if (result.has(normalized.title)) {
			throw new Error(
				"Duplicate " + description + " snapshot title"
			);
		}

		result.set(normalized.title, normalized);
	});

	return result;
}

function Plan(snapshot) {
	var source = schemas.copyJSON(snapshot);

	if (!schemas.isRecord(source)) {
		throw new Error("Plan requires a store snapshot");
	}

	this.baseline = load(source.materialized, "materialized");
	this.current = new Map(this.baseline);
	this.shadows = load(source.shadows, "shadow");
	this.touched = new Set();
	this.state = "open";
	this.compiled = null;
    this.revision = 0;
    this.parent = null;
    this.parentRevision = null;
	this.messages = new Map();
	this.deferred = new Map();
}

Plan.prototype.assertOpen = function () {
	if (this.state !== "open") {
		throw new Error("Plan is not open: " + this.state);
	}

	if (this.parent !== null) {
		this.parent.assertOpen();
	}
};

Plan.prototype.initial = function (title) {
	this.assertOpen();

	return this.baseline.has(title)
		? schemas.copyJSON(this.baseline.get(title))
		: null;
};

Plan.prototype.read = function (title) {
	this.assertOpen();

	if (typeof title !== "string" || title.length === 0) {
		throw new Error("Tiddler title must be non-empty");
	}

	if (this.current.has(title)) {
		return {
			kind: "materialized",
			fields: schemas.copyJSON(this.current.get(title))
		};
	}

	if (this.shadows.has(title)) {
		return {
			kind: "shadow",
			fields: schemas.copyJSON(this.shadows.get(title))
		};
	}

	return {
		kind: "absent",
		fields: null
	};
};

Plan.prototype.apply = function (value) {
	this.assertOpen();

	if (!value || value.version !== 1) {
		throw new Error("Invalid planned transition");
	}

	var effect = transitions.transition(
		value.title,
		value.before,
		value.after
	);

	if (this.shadows.has(effect.title)) {
		throw new Error(
			"Planned writes to shadow-backed targets are not supported"
		);
	}

	var current = this.current.has(effect.title)
		? this.current.get(effect.title)
		: null;

	if (equal(current, effect.after)) {
		return "already-applied";
	}

	if (!equal(current, effect.before)) {
		throw new Error(
			"Planned transition conflict: " + effect.title
		);
	}

	if (effect.after === null) {
		this.current.delete(effect.title);
	} else {
		this.current.set(effect.title, effect.after);
	}

	this.touched.add(effect.title);
    this.revision++;

	return "applied";
};

Plan.prototype.defer = function (value) {
	this.assertOpen();

	var effect = deferredEffects.validate(value);
	var title = effect.recipient.title;
	var previous = this.deferred.get(title);

	if (previous) {
		if (
			previous.platform !== effect.platform ||
			previous.recipient.executor !==
				effect.recipient.executor
		) {
			throw new Error(
				"Deferred recipient changed inside the plan"
			);
		}

		return "already-recorded";
	}

	var reused = Array.from(this.deferred.values()).some(
		function (candidate) {
			return candidate.id === effect.id;
		}
	);

	if (reused) {
		throw new Error(
			"Deferred identity was reused for another recipient"
		);
	}

	this.deferred.set(title, effect);
	this.revision++;

	return "recorded";
};

Plan.prototype.export = function () {
	if (this.state === "aborted") {
		throw new Error("Cannot export an aborted plan");
	}

	if (this.compiled !== null) {
		return schemas.copyJSON(this.compiled);
	}

	this.assertOpen();

	var effects = [];

	Array.from(this.touched).sort().forEach(function (title) {
		var before = this.baseline.has(title)
			? this.baseline.get(title)
			: null;

		var after = this.current.has(title)
			? this.current.get(title)
			: null;

		if (!equal(before, after)) {
			effects.push(transitions.transition(
				title,
				before,
				after
			));
		}
	}, this);

	return schemas.copyJSON({
		version: 1,
		effects: effects,
		messages: Array.from(this.messages.values()),
		deferred: Array.from(this.deferred.values())
	});
};

Plan.prototype.fork = function () {
	this.assertOpen();

	var branch = Object.create(Plan.prototype);

	/*
		Field snapshots are immutable normalized records.
		Maps and sets must be independent.
	*/
	branch.baseline = new Map(this.baseline);
	branch.current = new Map(this.current);
	branch.shadows = new Map(this.shadows);
	branch.touched = new Set(this.touched);
	branch.messages = new Map(this.messages);

	branch.state = "open";
	branch.compiled = null;
	branch.revision = this.revision;

	branch.parent = this;
	branch.parentRevision = this.revision;

	branch.deferred = new Map(this.deferred);

	return branch;
};

Plan.prototype.accept = function (branch) {
	this.assertOpen();

	if (
		!(branch instanceof Plan) ||
		branch.parent !== this
	) {
		throw new Error("Plan branch belongs to another parent");
	}

	branch.assertOpen();

	if (branch.parentRevision !== this.revision) {
		throw new Error("Plan branch is stale");
	}

	/*
		Prepare the replacement collections before publication.
		No effect is written to the authoritative store.
	*/
	var current = new Map(branch.current);
	var touched = new Set(branch.touched);
	var messages = new Map(branch.messages);
	var deferred = new Map(branch.deferred);

	this.current = current;
	this.touched = touched;
	this.messages = messages;
	this.deferred = deferred;
	this.revision++;

	branch.state = "accepted";
	branch.baseline.clear();
	branch.current.clear();
	branch.shadows.clear();
	branch.touched.clear();
	branch.messages.clear();
	branch.deferred.clear();
};

Plan.prototype.send = function (value) {
	this.assertOpen();

	var message = messageEffects.validate(value);
	var previous = this.messages.get(message.id);

	if (previous) {
		if (
			messageEffects.fingerprint(previous) !==
			messageEffects.fingerprint(message)
		) {
			throw new Error(
				"Message identity was reused for another effect"
			);
		}

		return "already-recorded";
	}

	this.messages.set(message.id, message);
	this.revision++;

	return "recorded";
};

Plan.prototype.transact = function (prepare) {
	this.assertOpen();

	if (typeof prepare !== "function") {
		throw new Error("Plan operation requires a preparation function");
	}

	var branch = this.fork();

	try {
		var result = prepare(branch);

		if (
			result !== null &&
			result !== undefined &&
			typeof result.then === "function"
		) {
			throw new Error("Plan operations must be synchronous");
		}

		this.accept(branch);

		return result;
	} catch (error) {
		if (branch.state === "open") {
			branch.abort();
		}

		throw error;
	}
};

Plan.prototype.seal = function () {
	this.assertOpen();

    if (this.parent !== null) {
        throw new Error("Plan branch must be accepted, not sealed");
    }

	this.compiled = this.export();
	this.state = "sealed";

	this.baseline.clear();
	this.current.clear();
	this.shadows.clear();
	this.touched.clear();
	this.messages.clear();
	this.deferred.clear();

	return schemas.copyJSON(this.compiled);
};

Plan.prototype.abort = function () {
	/*
		An orphaned branch may still be explicitly disposed of
		after its parent has closed.
	*/
	if (this.state !== "open") {
		throw new Error("Plan is not open: " + this.state);
	}

	this.state = "aborted";
	this.baseline.clear();
	this.current.clear();
	this.shadows.clear();
	this.touched.clear();
	this.messages.clear();
	this.deferred.clear();
};

Plan.prototype.each = function (callback) {
	this.assertOpen();

	if (typeof callback !== "function") {
		throw new Error("Plan enumeration requires a callback");
	}

	var entries = Array.from(this.current.entries());

	entries.sort(function (left, right) {
		return left[0] < right[0]
			? -1
			: left[0] > right[0] ? 1 : 0;
	});

	entries.forEach(function (entry) {
		this.assertOpen();

		callback(
			schemas.copyJSON(entry[1]),
			entry[0]
		);
	}, this);
};

exports.Plan = Plan;