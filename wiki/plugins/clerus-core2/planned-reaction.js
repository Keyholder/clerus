/*\
title: $:/plugins/clerus/core2/planned-reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");
var Plan = require("$:/plugins/clerus/core2/plan.js").Plan;
var plannedScopes = require(
	"$:/plugins/clerus/core2/planned-scope.js"
);

function define(record, key, value) {
	Object.defineProperty(record, key, {
		value: value,
		enumerable: true,
		writable: true,
		configurable: true
	});
}

function freezeTree(value) {
	if (value !== null && typeof value === "object") {
		Object.keys(value).forEach(function (key) {
			freezeTree(value[key]);
		});

		Object.freeze(value);
	}

	return value;
}

function execute(options) {
	schemas.assertPlatform(options.platform);

	var space = jobTitles.classify(options.title);

	if (!space || !space.persistent) {
		throw new Error(
			"Planned reaction requires a persistent job title"
		);
	}

	if (
		!options.store ||
		typeof options.store.snapshot !== "function" ||
		typeof options.handler !== "function"
	) {
		throw new Error(
			"Planned reaction requires a snapshot store and handler"
		);
	}

	var event = schemas.copyJSON(options.event);

	if (
		!schemas.isRecord(event) ||
		typeof event.type !== "string" ||
		event.type.length === 0
	) {
		throw new Error("Planned reaction requires an event type");
	}

	define(event, "title", options.title);
	define(event, "platform", options.platform);
	freezeTree(event);

	var plan = new Plan(options.store.snapshot());
	var scope = null;

	try {
		var initial = plan.read(options.title);

		if (
			initial.kind !== "materialized" ||
			initial.fields.type !== "application/json" ||
			typeof initial.fields["clerus-executor"] !== "string" ||
			initial.fields["clerus-executor"].length === 0
		) {
			throw new Error(
				"Planned reaction requires a materialized JSON job"
			);
		}

		var executor = initial.fields["clerus-executor"];

		scope = plannedScopes.open({
			plan: plan,
			title: options.title,
			platform: options.platform,
			eventType: event.type,
			incoming: options.incoming
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

		/*
			The current plan format cannot retain unsent registries.
			Do not silently discard them when closing the scope.
		*/
		scope.assertOutgoingResolved();

		var ownerState = plan.initial(options.title);

		scope.close();
		scope = null;

		var compiled = plan.seal();

		return schemas.copyJSON({
			version: 1,
			owner: {
				title: options.title,
				executor: executor,
				state: ownerState
			},
			plan: compiled
		});
	} catch (error) {
		if (scope) {
			scope.close();
			scope = null;
		}

		if (plan.state === "open") {
			plan.abort();
		}

		throw error;
	} finally {
		if (scope) {
			scope.close();
		}
	}
}

exports.execute = execute;