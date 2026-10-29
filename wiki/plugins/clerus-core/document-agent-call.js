/*\
title: $:/plugins/clerus/core/document-agent-call.js
type: application/javascript
module-type: clerus-document
\*/

"use strict";

var copyJSON = require("$:/plugins/clerus/core/json.js").copy;

var PHASES = [
	"idle",
	"queued",
	"running",
	"completed",
	"failed",
	"uncertain"
];

function validate(document) {
	if (
		!document ||
		document.form !== "agent-call" ||
		typeof document.id !== "string" ||
		!/^[A-Za-z0-9_-]+$/.test(document.id) ||
		typeof document.sequence !== "string" ||
		!/^(0|[1-9][0-9]*)$/.test(document.sequence) ||
		!Number.isSafeInteger(Number(document.sequence)) ||
		PHASES.indexOf(document.phase) === -1
	) {
		throw new Error("Invalid agent-call document");
	}

	if (
		document.phase !== "idle" &&
		(
			document.operation !==
				document.id + "-" + document.sequence ||
			!Object.prototype.hasOwnProperty.call(document, "request")
		)
	) {
		throw new Error("Invalid agent-call operation");
	}

	if (
		document.phase === "completed" &&
		!Object.prototype.hasOwnProperty.call(document, "response")
	) {
		throw new Error("Completed agent call must contain a response");
	}

	if (
		(
			document.phase === "failed" ||
			document.phase === "uncertain"
		) &&
		(
			!document.error ||
			typeof document.error !== "object" ||
			Array.isArray(document.error) ||
			typeof document.error.message !== "string"
		)
	) {
		throw new Error("Settled agent call must contain an error");
	}
}

exports.validate = validate;

function submission(document, request) {
	validate(document);

	if (
		document.phase === "queued" ||
		document.phase === "running"
	) {
		throw new Error("Agent call is already pending");
	}

	var sequence = Number(document.sequence) + 1;

	if (!Number.isSafeInteger(sequence)) {
		throw new Error("Agent-call sequence exhausted");
	}

	var nextRequest = copyJSON(request);

	if (nextRequest === undefined) {
		throw new Error("Agent-call request must be JSON");
	}

	return {
		form: "agent-call",
		id: document.id,
		sequence: String(sequence),
		operation: document.id + "-" + sequence,
		phase: "queued",
		request: nextRequest
	};
}

exports.submission = submission;

exports.forms = {
	"agent-call": function (access) {
		function read() {
			var document = access.read();
			validate(document);
			return document;
		}

		return Object.freeze({
			inspect: read,

			submit: function (request) {
				access.replace(submission(read(), request));
			}
		});
	}
};

exports.rules = {
	"agent-call": {
		transfer: "never",
		receipt: "automatic",
		messages: []
	}
};