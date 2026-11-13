/*\
title: $:/plugins/clerus/core/continuation-termination.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var stores = require("$:/plugins/clerus/core/store.js");
var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);
var events = require("$:/plugins/clerus/core/event-schema.js");

var hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);

function eligible(event) {
	return event.kind === "notification" ||
		event.kind === "activation" ||
		(
			event.kind === "delivery" &&
			Object.keys(event.registry).length === 0
		);
}

function hasHistory(record) {
	return record.diagnostics.some(function (entry) {
		return entry.action === "user-terminated" ||
			entry.action === "user-resolved";
	});
}

function recorded(record, id) {
	return record.diagnostics.some(function (entry) {
		if (
			entry.action !== "user-terminated" ||
			entry.phase !== "administrative" ||
			entry.event !== id ||
			!hasOwn(record.evidence.identities, id) ||
			entry.fingerprint !== record.evidence.identities[id]
		) {
			return false;
		}

		try {
			var event = events.validate(entry.snapshot);

			return eligible(event) &&
				events.fingerprint(event) === entry.fingerprint;
		} catch (error) {
			return false;
		}
	});
}

function terminate(options) {
	schemas.assertPlatform(options.platform);
	events.identity(options.eventId);

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
			"Event termination requires a continuation under user custody"
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
			custody: "user"
		};
	}

	/*
	A repeated request may confirm a write whose caller saw an
	exception. It does not create a new administrative operation.
	*/
	if (!hasOwn(record.events, options.eventId)) {
		if (recorded(record, options.eventId)) {
			return result("already-terminated");
		}

		throw new Error("Select a paused event");
	}

	if (record.work !== null) {
		throw new Error(
			"Cannot terminate an event during active materialization"
		);
	}

	var waiting = record.events[options.eventId];

	if (waiting.mode !== "paused") {
		throw new Error("Select a paused event");
	}

	if (!eligible(waiting.event)) {
		throw new Error(
			"Incoming documents require explicit disposition before termination"
		);
	}

	record.diagnostics.push({
		event: options.eventId,
		phase: "administrative",
		action: "user-terminated",
		fingerprint: record.evidence.identities[options.eventId],
		snapshot: schemas.copyJSON(waiting.event)
	});

	delete record.events[options.eventId];

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

		error.name = "ContinuationTerminationError";
		error.cause = cause;
		error.obligationTitle = options.title;
		error.eventId = options.eventId;
		error.acceptanceUncertain = true;

		throw error;
	}

	return result("terminated");
}

exports.eligible = eligible;
exports.hasHistory = hasHistory;
exports.terminate = terminate;