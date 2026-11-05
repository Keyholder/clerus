/*\
title: $:/plugins/clerus/core/work-materializer.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var works = require("$:/plugins/clerus/core/work-schema.js");
var stores = require("$:/plugins/clerus/core/store.js");

function equal(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function normalize(fields) {
	return stores.transition(
		fields.title,
		fields,
		fields
	).after;
}

function check(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.store.read !== "function" ||
		typeof options.store.check !== "function"
	) {
		throw new Error("Work checking requires a state store");
	}

	var work = works.validate(options.work);

	work.checks.forEach(function (condition) {
		var current = options.store.read(condition.title);

		if (current.kind === "shadow") {
			throw new Error(
				"Work check is shadow-backed: " + condition.title
			);
		}

		var matches = condition.state === null
			? current.kind === "absent"
			: current.kind === "materialized" &&
				equal(normalize(current.fields), condition.state);

		if (!matches) {
			throw new Error(
				"Work check conflict: " + condition.title
			);
		}
	});

	work.transitions.forEach(function (effect) {
		/*
			Check serialized accepted authority separately from
			the current before/after materialization state.
		*/
		var authorized = effect.before === null
			? effect.after
			: effect.before;

		if (
			authorized["clerus-custody"] !== options.platform
		) {
			throw new Error(
				"Invalid accepted work authority: " + effect.title
			);
		}

		options.store.check(effect);
	});

	return work;
}

function execute(options) {
	if (
		!options.store ||
		typeof options.store.apply !== "function"
	) {
		throw new Error("Work execution requires a writable store");
	}

	/*
		Check the whole package before the first write.

		This is not an atomic multi-tiddler transaction.
		The caller must preserve the accepted work until completion.
	*/
	var work = check(options);

	return work.transitions.map(function (effect) {
		return options.store.apply(effect);
	});
}

exports.check = check;
exports.execute = execute;