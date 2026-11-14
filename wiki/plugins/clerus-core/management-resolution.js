/*\
title: $:/plugins/clerus/core/management-resolution.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var events = require("$:/plugins/clerus/core/event-schema.js");
var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);
var resolutions = require(
	"$:/plugins/clerus/core/continuation-resolution.js"
);
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");

function create(options) {
	schemas.assertPlatform(options.platform);

	var prefix = "$:/clerus/resolutions/";
	var walPrefix = "$:/clerus/wal/" + options.platform + "/";

	function readJournal(title) {
		if (
			typeof title !== "string" ||
			title.indexOf(walPrefix) !== 0 ||
			title.length === walPrefix.length
		) {
			throw new Error("Select a continuation belonging to this platform");
		}

		if (!options.wiki.tiddlerExists(title)) {
			throw new Error("Continuation is not materialized");
		}

		var fields = options.wiki.getTiddler(title).fields;

		if (
			fields.type !== "application/json" ||
			fields["clerus-wal-kind"] !== "continuation" ||
			fields["clerus-custody"] !== "user"
		) {
			throw new Error(
				"Resolution requires a continuation under user custody"
			);
		}

		return continuations.validate(
			JSON.parse(fields.text),
			options.platform,
			title
		);
	}

	function prepare(journal, eventId) {
		events.identity(eventId);

		var record = readJournal(journal);

		if (
			record.work !== null ||
			!Object.prototype.hasOwnProperty.call(record.events, eventId) ||
			record.events[eventId].mode !== "paused"
		) {
			throw new Error("Select a paused event without active materialization");
		}

		var event = record.events[eventId].event;
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

		var id = events.identity(options.newId());
		var title = prefix + id;

		if (
			options.wiki.tiddlerExists(title) ||
			options.wiki.isShadowTiddler(title)
		) {
			throw new Error("Generated resolution title is occupied");
		}

		var request = {
			version: 1,
			kind: "event-resolution",
			platform: options.platform,
			journal: journal,
			eventId: eventId,
			fingerprint: record.evidence.identities[eventId],
			decision: {
				id: id,
				operations: Object.keys(event.registry).sort().map(
					function (key) {
						return {
							operation: "choose",
							key: key
						};
					}
				)
			}
		};

		options.wiki.addTiddler(new options.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": "user",
			text: JSON.stringify(request, null, 2)
		}));

		return {
			resolution: title,
			journal: journal,
			eventId: eventId,
			decisionId: id
		};
	}

	function accept(title) {
		if (
			typeof title !== "string" ||
			title.indexOf(prefix) !== 0 ||
			!options.wiki.tiddlerExists(title)
		) {
			throw new Error("Select a materialized resolution request");
		}

		var fields = options.wiki.getTiddler(title).fields;

		if (
			fields.type !== "application/json" ||
			fields["clerus-custody"] !== "user"
		) {
			throw new Error("Resolution request must be under user custody");
		}

		var request = schemas.copyJSON(JSON.parse(fields.text));

		if (
			!schemas.isRecord(request) ||
			Object.keys(request).some(function (key) {
				return [
					"version", "kind", "platform", "journal",
					"eventId", "fingerprint", "decision"
				].indexOf(key) === -1;
			}) ||
			request.version !== 1 ||
			request.kind !== "event-resolution" ||
			request.platform !== options.platform ||
			typeof request.fingerprint !== "string"
		) {
			throw new Error("Invalid resolution request");
		}

		events.identity(request.eventId);

		/*
		Reject unfinished choices before invoking the runtime.
		This does not allocate another decision identity.
		*/
		var decision = resolutions.decision(request.decision);

		if (title !== prefix + decision.id) {
			throw new Error("Resolution title does not match decision identity");
		}

		var record = readJournal(request.journal);

		if (
			!Object.prototype.hasOwnProperty.call(
				record.evidence.identities,
				request.eventId
			) ||
			record.evidence.identities[request.eventId] !==
				request.fingerprint
		) {
			throw new Error("Resolution request no longer matches its event");
		}

		/*
		The core owns acceptance and replay detection.
		Do not mark the request as accepted in a second write.
		*/
		return options.resolveEvent(
			request.journal,
			request.eventId,
			decision
		);
	}

	return Object.freeze({
		prepare: prepare,
		accept: accept
	});
}

exports.create = create;