/*\
title: $:/plugins/clerus/core/reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var scopes = require("$:/plugins/clerus/core/scope.js");
var transitions = require("$:/plugins/clerus/core/store.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");

var reactionServices = require(
	"$:/plugins/clerus/core/reaction-services.js"
);

var executionContract = require(
	"$:/plugins/clerus/core/execution-contract.js"
);

var reactionEvents = require(
	"$:/plugins/clerus/core/reaction-event.js"
);

var establishmentInput = require(
	"$:/plugins/clerus/core/establishment-input.js"
);

var localCustody = require(
	"$:/plugins/clerus/core/local-custody.js"
);

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

function run(options, establishing) {
	schemas.assertPlatform(options.platform);

	var custody = localCustody.create({
		platform: options.platform
	});

	var store = options.store;

	if (
		!store ||
		typeof store.read !== "function" ||
		typeof store.apply !== "function"
	) {
		throw new Error("Reaction requires a store");
	}

	[
		"readJobs",
		"acceptMessage",
		"checkMessage",
		"newId",
		"checkDeferred",
		"acceptDeferred"
	].forEach(function (name) {
		if (
			options[name] !== undefined &&
			typeof options[name] !== "function"
		) {
			throw new Error(name + " must be a function");
		}
	});

	var incoming = options.incoming === undefined
		? undefined
		: schemas.registry(options.incoming, "incoming");

	var initial = store.read(options.title);
	var job;
	var handler;

	if (establishing) {
		var space = jobTitles.classify(options.title);

		if (
			!space ||
			space.persistent ||
			space.platform !== options.platform
		) {
			throw new Error(
				"Establishment requires a local ephemeral title"
			);
		}

		if (initial.kind !== "absent") {
			throw new Error("Establishment target must be absent");
		}

		if (incoming === undefined) {
			throw new Error("Establishment requires incoming documents");
		}

		var founding = establishmentInput.read(incoming, {
			temporary: true
		});

		var contract = founding.contract;

		if (typeof options.resolveExecutor !== "function") {
			throw new Error("Establishment requires an executor resolver");
		}

		handler = options.resolveExecutor(contract.executor);

		job = {
			title: options.title,
			executor: contract.executor,
			registry: null
		};
	} else {
		if (initial.kind !== "materialized") {
			throw new Error("Reaction requires a materialized job");
		}

		job = schemas.ephemeralJob(
			initial.fields,
			options.platform
		);

		handler = options.handler;
	}

	if (typeof handler !== "function") {
		throw new Error("Reaction requires an available handler");
	}

	var event = reactionEvents.prepare({
		event: options.event,
		title: job.title,
		platform: options.platform,
		establishing: establishing
	});

	var expected = initial.kind === "materialized"
		? schemas.copyJSON(initial.fields)
		: null;

	var scope = null;

	var services = reactionServices.create({
		title: job.title,
		platform: options.platform,
		store: store,
		readJobs: options.readJobs,
		newId: options.newId
	});

	function currentWritable() {
		if (expected === null) {
			return false;
		}

		var current = store.read(job.title);

		return current.kind === "materialized" &&
			custody.owns(current.fields) &&
			current.fields["clerus-executor"] === job.executor &&
			current.fields.type === "application/json" &&
			sameFields(current.fields, expected);
	}

	function establishOperational(registry) {
		if (!establishing || expected !== null) {
			throw new Error("Job cannot be established again");
		}

		if (store.read(job.title).kind !== "absent") {
			throw new Error("Establishment target became occupied");
		}

		var normalized = schemas.registry(
			registry,
			"operational"
		);

		var effect = transitions.transition(job.title, null, {
			title: job.title,
			type: "application/json",
			"clerus-custody": options.platform,
			"clerus-executor": job.executor,
			text: JSON.stringify(normalized)
		});

		store.apply(effect);
		expected = effect.after;
	}

	function commitOperational(before, after) {
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

		var effect = transitions.transition(
			job.title,
			expected,
			next
		);

		store.apply(effect);
		expected = effect.after;
	}

	try {
		scope = scopes.open(Object.assign({}, services, {
			operational: job.registry,
			incoming: incoming,
			eventType: event.type,

			checkMessage: options.checkMessage,
			acceptMessage: options.acceptMessage,
			canWriteOperational: currentWritable,
			commitOperational: commitOperational,

			establishOperational: establishing
				? establishOperational
				: undefined,

			checkDeferred: typeof options.checkDeferred === "function"
				? function () {
					options.checkDeferred(job.title, job.executor);
				}
				: undefined,

			acceptDeferred: typeof options.acceptDeferred === "function"
				? function () {
					options.acceptDeferred(job.title, job.executor);
				}
				: undefined
		}));

		executionContract.invoke({
			handler: handler,
			event: event,
			scope: scope,
			requireSentOutgoing: options.requireSentOutgoing
		});

		var snapshot = scope.snapshot();

		return {
			outgoing: snapshot.outgoing,
			messages: snapshot.messages
		};
	} finally {
		if (scope) {
			scope.close();
		}
	}
}

exports.execute = function (options) {
	return run(options, false);
};

exports.establish = function (options) {
	return run(options, true);
};