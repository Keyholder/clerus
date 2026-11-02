/*\
title: $:/plugins/clerus/core2/lifecycle.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");
var transitions = require("$:/plugins/clerus/core2/store.js");

function describeError(error) {
	return {
		name: String(error && error.name || "Error"),
		message: String(error && error.message || error),
		stack: error && error.stack ? String(error.stack) : null
	};
}

function create(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.store.read !== "function" ||
		typeof options.store.apply !== "function" ||
		typeof options.recordIncident !== "function"
	) {
		throw new Error(
			"Lifecycle requires a store and incident recorder"
		);
	}

	function dismiss(request) {
		var space = jobTitles.classify(request.title);

		if (
			!space ||
			space.persistent ||
			space.platform !== options.platform ||
			typeof request.executor !== "string" ||
			request.executor.length === 0
		) {
			throw new Error(
				"Dismissal requires a local ephemeral job identity"
			);
		}

		var event = schemas.copyJSON(request.event);

		if (
			!schemas.isRecord(event) ||
			typeof event.type !== "string" ||
			event.type.length === 0
		) {
			throw new Error("Dismissal requires an event");
		}

		var current = options.store.read(request.title);

		var result = {
			dismissed: false,
			reason: null,
			incident: null,
			incidentError: null,
			transitionError: null
		};

		try {
			var incident = options.recordIncident({
				kind: "executor-failure",
				platform: options.platform,
				owner: {
					title: request.title,
					executor: request.executor
				},
				event: event,
				error: describeError(request.error)
			});

			if (
				typeof incident !== "string" ||
				incident.length === 0
			) {
				throw new Error(
					"Incident recorder must return its record title"
				);
			}

			result.incident = incident;
		} catch (error) {
			result.incidentError = describeError(error);
		}

		/*
		An executor may fail before accepting its founding contract.
		There is then no job tiddler to transfer.
		*/
		if (current.kind !== "materialized") {
			result.reason = "job-not-materialized";
			return result;
		}

		if (
			current.fields["clerus-executor"] !== request.executor
		) {
			result.reason = "executor-changed";
			return result;
		}

		if (
			current.fields["clerus-custody"] !== options.platform
		) {
			result.reason = "not-locally-owned";
			return result;
		}

		/*
		Do not parse or repair the registry. Even a malformed body
		must remain available to the user exactly as it was.
		*/
		var after = schemas.copyJSON(current.fields);
		after["clerus-custody"] = "user";

		try {
			options.store.apply(transitions.transition(
				request.title,
				current.fields,
				after
			));

			result.dismissed = true;
		} catch (error) {
			result.reason = "transition-failed";
			result.transitionError = describeError(error);
		}

		return result;
	}

	return Object.freeze({
		dismiss: dismiss
	});
}

exports.create = create;
exports.describeError = describeError;