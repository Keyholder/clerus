/*\
title: $:/plugins/clerus/core2/store.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");

function assertTitle(title) {
	if (typeof title !== "string" || title.length === 0) {
		throw new Error("Tiddler title must be non-empty");
	}
}

function normalize(fields) {
	if (fields === null) {
		return null;
	}

	var source = schemas.copyJSON(fields);

	if (!schemas.isRecord(source)) {
		throw new Error("Snapshot fields must be a record");
	}

	assertTitle(source.title);

	var result = Object.create(null);

	Object.keys(source).sort().forEach(function (key) {
		if (typeof source[key] !== "string") {
			throw new Error("Snapshot field values must be strings");
		}

		Object.defineProperty(result, key, {
			value: source[key],
			enumerable: true,
			writable: true,
			configurable: true
		});
	});

	return result;
}

function capture(tiddler) {
	if (!tiddler) {
		return null;
	}

	var fields = Object.create(null);

	Object.keys(tiddler.fields).sort().forEach(function (key) {
		Object.defineProperty(fields, key, {
			value: tiddler.getFieldString(key),
			enumerable: true,
			writable: true,
			configurable: true
		});
	});

	return normalize(fields);
}

function equal(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function transition(title, before, after) {
	assertTitle(title);

	var initial = normalize(before);
	var final = normalize(after);

	if (
		(initial && initial.title !== title) ||
		(final && final.title !== title)
	) {
		throw new Error("Transition cannot change tiddler identity");
	}

	if (initial === null && final === null) {
		throw new Error("Transition must have an initial or final object");
	}

	if (initial) {
		Object.freeze(initial);
	}

	if (final) {
		Object.freeze(final);
	}

	return Object.freeze({
		version: 1,
		title: title,
		before: initial,
		after: final
	});
}

function validate(value) {
	if (!value || value.version !== 1) {
		throw new Error("Invalid material transition");
	}

	return transition(value.title, value.before, value.after);
}

function Store(options) {
	this.wiki = options.wiki;
	this.Tiddler = options.Tiddler;
}

Store.prototype.read = function (title) {
	assertTitle(title);

	if (this.wiki.tiddlerExists(title)) {
		return {
			kind: "materialized",
			fields: capture(this.wiki.getTiddler(title))
		};
	}

	if (this.wiki.isShadowTiddler(title)) {
		return {
			kind: "shadow",
			fields: capture(this.wiki.getTiddler(title))
		};
	}

	return {
		kind: "absent",
		fields: null
	};
};

Store.prototype.check = function (value) {
	var effect = validate(value);
	var current = this.read(effect.title);

	if (current.kind === "shadow") {
		throw new Error("Shadow-backed transition is not supported");
	}

	if (equal(current.fields, effect.after)) {
		return "already-applied";
	}

	if (!equal(current.fields, effect.before)) {
		throw new Error(
			"Material transition conflict: " + effect.title
		);
	}

	return "ready";
};

Store.prototype.apply = function (value) {
	var effect = validate(value);

	if (this.check(effect) === "already-applied") {
		return "already-applied";
	}

	/*
	Do not catch a write failure here.

	The caller must distinguish a rejected precondition from a failure
	after materialization may already have happened.
	*/
	if (effect.after === null) {
		this.wiki.deleteTiddler(effect.title);
	} else {
		this.wiki.addTiddler(new this.Tiddler(effect.after));
	}

	return "applied";
};

exports.Store = Store;
exports.capture = capture;
exports.transition = transition;