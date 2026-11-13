/*\
title: $:/plugins/clerus/core/continuation-resolution.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var stores = require("$:/plugins/clerus/core/store.js");
var events = require("$:/plugins/clerus/core/event-schema.js");
var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);
var plannedReactions = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
var proposalWork = require(
	"$:/plugins/clerus/core/proposal-work.js"
);
var compatibility = require(
	"$:/plugins/clerus/core/work-compatibility.js"
);
var materializer = require(
	"$:/plugins/clerus/core/work-materializer.js"
);
var custody = require(
	"$:/plugins/clerus/core/custody-schema.js"
);
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");

var hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);

function fieldsOnly(value, allowed, description) {
	if (
		!schemas.isRecord(value) ||
		Object.keys(value).some(function (key) {
			return allowed.indexOf(key) === -1;
		})
	) {
		throw new Error("Unsupported fields in " + description);
	}
}

function decision(value) {
	var source = schemas.copyJSON(value);

	fieldsOnly(source, ["id", "operations"], "event resolution");

	events.identity(source.id);

	if (!Array.isArray(source.operations)) {
		throw new Error("Resolution operations must be an array");
	}

	var keys = new Set();

	var operations = source.operations.map(function (operation) {
		fieldsOnly(
			operation,
			operation && operation.operation === "retain"
				? ["operation", "key", "destinationKey"]
				: ["operation", "key"],
			"resolution operation"
		);

		schemas.assertKey(operation.key);

		if (keys.has(operation.key)) {
			throw new Error("Repeated resolution source key");
		}

		keys.add(operation.key);

		if (operation.operation === "destroy") {
			return {
				operation: "destroy",
				key: operation.key
			};
		}

		if (operation.operation === "retain") {
			schemas.assertKey(operation.destinationKey);

			return {
				operation: "retain",
				key: operation.key,
				destinationKey: operation.destinationKey
			};
		}

		throw new Error("Unsupported resolution operation");
	});

	/*
	Order is normative: operations can affect local aliases.
	Do not sort the instruction sequence.
	*/
	return {
		id: source.id,
		operations: operations
	};
}

function resolve(options) {
	schemas.assertPlatform(options.platform);
	events.identity(options.eventId);

	var instruction = decision(options.decision);
	var prefix = "$:/clerus/wal/" + options.platform + "/";

	if (
		typeof options.title !== "string" ||
		options.title.indexOf(prefix) !== 0 ||
		options.title.length === prefix.length
	) {
		throw new Error("Select a continuation belonging to this platform");
	}

	var current = options.store.read(options.title);

	if (
		current.kind !== "materialized" ||
		current.fields.type !== "application/json" ||
		current.fields["clerus-wal-kind"] !== "continuation" ||
		current.fields["clerus-custody"] !== "user"
	) {
		throw new Error(
			"Event resolution requires a continuation under user custody"
		);
	}

	var record = continuations.validate(
		JSON.parse(current.fields.text),
		options.platform,
		options.title
	);

	function result(status) {
		return {
			status: status,
			journal: options.title,
			eventId: options.eventId,
			decisionId: instruction.id,
			custody: "user"
		};
	}

	var previous = record.diagnostics.filter(function (entry) {
		return entry.action === "user-resolved" &&
			entry.decision &&
			entry.decision.id === instruction.id;
	});

	if (previous.length > 0) {
		if (
			previous.length !== 1 ||
			previous[0].event !== options.eventId ||
			JSON.stringify(previous[0].decision) !==
				JSON.stringify(instruction) ||
			!hasOwn(record.evidence.identities, options.eventId) ||
			previous[0].fingerprint !==
				record.evidence.identities[options.eventId] ||
			hasOwn(record.events, options.eventId)
		) {
			throw new Error("Resolution identity has different content");
		}

		return result("already-accepted");
	}

	if (record.work !== null) {
		throw new Error(
			"Cannot resolve an event during active materialization"
		);
	}

	if (
		!hasOwn(record.events, options.eventId) ||
		record.events[options.eventId].mode !== "paused"
	) {
		throw new Error("Select a paused event");
	}

	var event = record.events[options.eventId].event;
	var space = jobTitles.classify(event.recipient.title);

	if (
		event.kind !== "delivery" ||
		event.establishing === true ||
		!space ||
		!space.persistent
	) {
		throw new Error(
			"Resolution requires a non-establishing persistent delivery"
		);
	}

	var sourceKeys = Object.keys(event.registry).sort();
	var instructedKeys = instruction.operations.map(function (operation) {
		return operation.key;
	}).sort();

	if (
		JSON.stringify(sourceKeys) !== JSON.stringify(instructedKeys)
	) {
		throw new Error(
			"Resolution must explicitly cover every incoming document"
		);
	}

	var owner = options.store.read(event.recipient.title);

	if (
		owner.kind !== "materialized" ||
		owner.fields["clerus-executor"] !== event.recipient.executor
	) {
		throw new Error("Resolution recipient has changed");
	}

	var reactionEvent = {
		type: event.type,
		id: options.eventId
	};

	if (event.type === "report") {
		reactionEvent.project = event.project;
		reactionEvent.role = event.role.slice();
	}

	var proposal = plannedReactions.execute({
		store: options.store,
		title: event.recipient.title,
		platform: options.platform,
		event: reactionEvent,
		incoming: event.registry,
		newId: options.newId,

		handler: function (delivered, operational, incoming) {
			instruction.operations.forEach(function (operation) {
				if (operation.operation === "destroy") {
					incoming.destroy(operation.key);
				} else {
					incoming.move(
						operation.key,
						operational,
						operation.destinationKey
					);
				}
			});
		}
	});

	/*
	Check even an effect-free proposal: unknown or conflicting
	accepted work must not be bypassed by administrative repair.
	*/
	compatibility.check({
		store: options.store,
		title: options.title,
		proposal: proposal
	});

	var latestOwner = options.store.read(event.recipient.title);

	if (
		latestOwner.kind !== "materialized" ||
		JSON.stringify(latestOwner.fields) !==
			JSON.stringify(proposal.owner.state)
	) {
		throw new Error("Resolution recipient baseline has changed");
	}

	var work = proposalWork.convert(
		proposal,
		instruction.id,
		options.platform
	);

	if (work !== null && record.retainUntil !== undefined) {
		work = custody.withRetention(work, record.retainUntil);
	}

	if (work !== null) {
		compatibility.check({
			store: options.store,
			title: options.title,
			work: work
		});

		materializer.check({
			store: options.store,
			platform: options.platform,
			work: work
		});
	}

	record.diagnostics.push({
		event: options.eventId,
		phase: "administrative",
		action: "user-resolved",
		fingerprint: record.evidence.identities[options.eventId],
		decision: instruction,
		snapshot: schemas.copyJSON(event)
	});

	delete record.events[options.eventId];
	record.work = work;

	record = continuations.validate(
		record,
		options.platform,
		options.title
	);

	var after = schemas.copyJSON(current.fields);
	after.text = JSON.stringify(record);

	try {
		options.store.apply(stores.transition(
			options.title,
			current.fields,
			after
		));
	} catch (cause) {
		var error = new Error(
			String(cause && cause.message || cause)
		);

		error.name = "ContinuationResolutionError";
		error.cause = cause;
		error.obligationTitle = options.title;
		error.eventId = options.eventId;
		error.decisionId = instruction.id;
		error.acceptanceUncertain = true;

		throw error;
	}

	return result("accepted");
}

exports.decision = decision;
exports.resolve = resolve;