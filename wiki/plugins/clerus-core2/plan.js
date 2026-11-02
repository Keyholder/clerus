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
}

Plan.prototype.assertOpen = function () {
	if (this.state !== "open") {
		throw new Error("Plan is not open: " + this.state);
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

Plan.prototype.seal = function () {
	this.assertOpen();

	this.compiled = this.export();
	this.state = "sealed";

	this.baseline.clear();
	this.current.clear();
	this.shadows.clear();
	this.touched.clear();

	return schemas.copyJSON(this.compiled);
};

Plan.prototype.abort = function () {
	this.assertOpen();

	this.state = "aborted";
	this.baseline.clear();
	this.current.clear();
	this.shadows.clear();
	this.touched.clear();
};

exports.Plan = Plan;