/*\
title: $:/plugins/clerus/core2/reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var scopes = require("$:/plugins/clerus/core2/scope.js");
var transitions = require("$:/plugins/clerus/core2/store.js");

function freezeTree(value) {
	if (value !== null && typeof value === "object") {
		Object.keys(value).forEach(function (key) {
			freezeTree(value[key]);
		});

		Object.freeze(value);
	}

	return value;
}

function define(record, key, value) {
	Object.defineProperty(record, key, {
		value: value,
		enumerable: true,
		writable: true,
		configurable: true
	});
}

function sameFields(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function execute(options) {
	schemas.assertPlatform(options.platform);

	if (typeof options.handler !== "function") {
		throw new Error("Reaction requires a handler");
	}

	var store = options.store;

	if (
		!store ||
		typeof store.read !== "function" ||
		typeof store.apply !== "function"
	) {
		throw new Error("Reaction requires a store");
	}

	var initial = store.read(options.title);

	if (initial.kind !== "materialized") {
		throw new Error("Reaction requires a materialized job");
	}

	var job = schemas.ephemeralJob(
		initial.fields,
		options.platform
	);

	var event = schemas.copyJSON(options.event);

	if (
		!schemas.isRecord(event) ||
		typeof event.type !== "string" ||
		event.type.length === 0
	) {
		throw new Error("Reaction requires an event type");
	}

	/*
	The caller supplies event-specific data, but cannot override
	the receiving identity or execution platform.
	*/
	define(event, "title", job.title);
	define(event, "platform", options.platform);

	freezeTree(event);

	var expected = schemas.copyJSON(initial.fields);
	var scope = null;

	function currentWritable() {
		var current = store.read(job.title);

		return current.kind === "materialized" &&
			current.fields["clerus-custody"] === options.platform &&
			current.fields["clerus-executor"] === job.executor &&
			current.fields.type === "application/json" &&
			sameFields(current.fields, expected);
	}

	function commitOperational(before, after) {
		/*
		Repeat the check at the write boundary.
		The earlier scope check is not permission to overwrite
		an intervening state.
		*/
		if (!currentWritable()) {
			throw new Error(
				"Operational registry write precondition failed"
			);
		}

		var expectedRegistry = schemas.registry(
			JSON.parse(expected.text),
			"operational"
		);

		if (
			JSON.stringify(expectedRegistry) !==
			JSON.stringify(before)
		) {
			throw new Error(
				"Operational scope diverged from stored registry"
			);
		}

		var next = schemas.copyJSON(expected);

		define(next, "text", JSON.stringify(after));

		store.apply(transitions.transition(
			job.title,
			expected,
			next
		));

		// Normalize field order exactly as Store does.
		expected = transitions.transition(
			job.title,
			next,
			next
		).after;
	}

	try {
		scope = scopes.open({
			operational: job.registry,
			incoming: options.incoming,
			readTiddler: store.read.bind(store),
			canWriteOperational: currentWritable,
			commitOperational: commitOperational
		});

		var returned = options.handler(
			event,
			scope.operational,
			scope.incoming
		);

		if (
			returned !== null &&
			returned !== undefined &&
			typeof returned.then === "function"
		) {
			throw new Error(
				"Executor reactions must be synchronous"
			);
		}

		scope.assertResolved();

		return {
			outgoing: scope.snapshot().outgoing
		};
	} finally {
		if (scope) {
			scope.close();
		}
	}
}

exports.execute = execute;