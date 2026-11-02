/*\
title: $:/plugins/clerus/core2/plan.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var transitions = require("$:/plugins/clerus/core2/store.js");

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
		effects: effects
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

	branch.state = "open";
	branch.compiled = null;
	branch.revision = this.revision;

	branch.parent = this;
	branch.parentRevision = this.revision;

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

	this.current = current;
	this.touched = touched;
	this.revision++;

	branch.state = "accepted";
	branch.baseline.clear();
	branch.current.clear();
	branch.shadows.clear();
	branch.touched.clear();
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
};

exports.Plan = Plan;