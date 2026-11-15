/*\
title: $:/plugins/clerus/core/resolution-view.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);
var resolutions = require(
	"$:/plugins/clerus/core/continuation-resolution.js"
);
var events = require("$:/plugins/clerus/core/event-schema.js");

var hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);
var PREFIX = "$:/clerus/resolutions/";

function fieldsOnly(value, allowed) {
	return schemas.isRecord(value) &&
		Object.keys(value).every(function (key) {
			return allowed.indexOf(key) !== -1;
		});
}

function readOne(options, tiddler, title) {
	var item = {
		title: title,
		platform: options.platform,
		state: "unconfirmed",
		error: null,
		decisionError: null,
		evidenceError: null,
		request: null,
		decision: null,
		accepted: null,
		activeAcceptedWork: false,
		contentMatches: null,
		journal: null,
		eventId: null,
		canAccept: false,
		dependencies: []
	};

	var request;

	try {
		if (
			tiddler.fields.type !== "application/json"
		) {
			throw new Error("Resolution request must have type application/json");
		}

		request = schemas.copyJSON(JSON.parse(tiddler.fields.text));

		if (
			!fieldsOnly(request, [
				"version", "kind", "platform", "journal",
				"eventId", "fingerprint", "decision"
			]) ||
			request.version !== 1 ||
			request.kind !== "event-resolution" ||
			(request.platform !== "browser" && request.platform !== "node") ||
			typeof request.journal !== "string" ||
			request.journal.indexOf(
				"$:/clerus/wal/" + request.platform + "/"
			) !== 0 ||
			typeof request.fingerprint !== "string"
		) {
			throw new Error("Invalid resolution request");
		}

		events.identity(request.eventId);

		item.request = request;
		item.journal = request.journal;
		item.eventId = request.eventId;
		item.dependencies = [request.journal];
	} catch (error) {
		item.state = "invalid";
		item.error = String(error.message);
		return item;
	}

	if (request.platform !== options.platform) {
		item.state = "foreign";
		return item;
	}

	/*
	The request title fixes the decision identity. An edited
	decision.id must not hide the receipt for that original id.
	*/
	var expectedId = title.slice(PREFIX.length);

	try {
		events.identity(expectedId);
	} catch (error) {
		item.state = "invalid";
		item.error = String(error.message);
		return item;
	}

	try {
		item.decision = resolutions.decision(request.decision);

		if (item.decision.id !== expectedId) {
			throw new Error(
				"Resolution title does not match decision identity"
			);
		}
	} catch (error) {
		item.decision = null;
		item.decisionError = String(error.message);
	}

	var journal = options.wiki.tiddlerExists(request.journal)
		? options.wiki.getTiddler(request.journal)
		: null;
	var record;

	try {
		if (
			!journal ||
			journal.fields.type !== "application/json" ||
			journal.fields["clerus-wal-kind"] !== "continuation"
		) {
			throw new Error("Continuation is not available");
		}

		record = continuations.validate(
			JSON.parse(journal.fields.text),
			options.platform,
			request.journal
		);
	} catch (error) {
		item.evidenceError = String(error.message);
		return item;
	}

	var receipts = record.diagnostics.filter(function (entry) {
		return entry.action === "user-resolved" &&
			entry.decision &&
			entry.decision.id === expectedId;
	});

	if (receipts.length > 0) {
		try {
			if (receipts.length !== 1) {
				throw new Error("Resolution receipt is ambiguous");
			}

			var receipt = receipts[0];
			var acceptedDecision = resolutions.decision(receipt.decision);
			var snapshot = events.validate(receipt.snapshot);

			if (
				receipt.phase !== "administrative" ||
				!hasOwn(record.evidence.identities, receipt.event) ||
				record.evidence.identities[receipt.event] !==
					receipt.fingerprint ||
				events.fingerprint(snapshot) !== receipt.fingerprint ||
				hasOwn(record.events, receipt.event)
			) {
				throw new Error("Invalid resolution receipt");
			}

			item.accepted = {
				eventId: receipt.event,
				fingerprint: receipt.fingerprint,
				decision: acceptedDecision,
				snapshot: snapshot
			};

			item.contentMatches = item.decision !== null &&
				request.eventId === receipt.event &&
				request.fingerprint === receipt.fingerprint &&
				JSON.stringify(item.decision) ===
					JSON.stringify(acceptedDecision);

			item.activeAcceptedWork = record.work !== null &&
				record.work.id === expectedId;

			item.state = item.contentMatches
				? "accepted"
				: "changed";
		} catch (error) {
			item.evidenceError = String(error.message);
		}

		return item;
	}

	/*
	No matching receipt is not proof of non-acceptance.
	This is only a conservative availability hint.
	The command and core repeat all normative checks.
	*/
	var waiting = record.events[request.eventId];
	var matchesEvent = waiting &&
		hasOwn(record.evidence.identities, request.eventId) &&
		record.evidence.identities[request.eventId] ===
			request.fingerprint;

	var supported = matchesEvent &&
		waiting.event.kind === "delivery" &&
		waiting.event.establishing !== true &&
		waiting.event.recipient.title.indexOf("$:/clerus/jobs/") === 0;

	var coversIncoming = false;

	if (supported && item.decision !== null) {
		var keys = item.decision.operations.map(function (operation) {
			return operation.key;
		}).sort();

		coversIncoming = JSON.stringify(keys) === JSON.stringify(
			Object.keys(waiting.event.registry).sort()
		);
	}

	item.canAccept =
		tiddler.fields["clerus-custody"] === "user" &&
		journal.fields["clerus-custody"] === "user" &&
		record.work === null &&
		!!supported &&
		waiting.mode === "paused" &&
		item.decision !== null &&
		coversIncoming;

	return item;
}

exports.read = function (options) {
	schemas.assertPlatform(options.platform);

	var result = [];

	options.wiki.each(function (tiddler, title) {
		if (title.indexOf(PREFIX) === 0) {
			result.push(readOne(options, tiddler, title));
		}
	});

	result.sort(function (left, right) {
		return left.title < right.title ? -1 :
			left.title > right.title ? 1 : 0;
	});

	return result;
};