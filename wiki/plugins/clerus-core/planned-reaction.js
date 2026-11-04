/*\
title: $:/plugins/clerus/core/planned-reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var transitions = require("$:/plugins/clerus/core/store.js");
var Plan = require("$:/plugins/clerus/core/plan.js").Plan;
var plannedScopes = require(
	"$:/plugins/clerus/core/planned-scope.js"
);
var jobState = require("$:/plugins/clerus/core/job-state.js");

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

function run(options, establishing) {
	schemas.assertPlatform(options.platform);

	var space = jobTitles.classify(options.title);

	if (!space || !space.persistent) {
		throw new Error(
			"Planned reaction requires a persistent job title"
		);
	}

	if (
		!options.store ||
		typeof options.store.snapshot !== "function"
	) {
		throw new Error("Planned reaction requires a snapshot store");
	}

	if (
		options.newId !== undefined &&
		typeof options.newId !== "function"
	) {
		throw new Error("newId must be a function");
	}

	var event = schemas.copyJSON(
		establishing && options.event === undefined
			? { type: "order" }
			: options.event
	);

	if (
		!schemas.isRecord(event) ||
		typeof event.type !== "string" ||
		event.type.length === 0 ||
		(establishing && event.type !== "order")
	) {
		throw new Error("Invalid planned reaction event");
	}

	define(event, "title", options.title);
	define(event, "platform", options.platform);
	freezeTree(event);

	var incoming = options.incoming === undefined
		? undefined
		: schemas.registry(options.incoming, "incoming");

	var plan = new Plan(options.store.snapshot());
	var scope = null;

	try {
		var initial = plan.read(options.title);
		var executor;
		var handler;

		if (establishing) {
			if (initial.kind !== "absent") {
				throw new Error(
					"Planned establishment target must be absent"
				);
			}

			if (incoming === undefined) {
				throw new Error(
					"Planned establishment requires incoming documents"
				);
			}

			var contracts = Object.keys(incoming).filter(
				function (key) {
					return schemas.formOf(incoming[key]) === "contract";
				}
			);

			if (contracts.length !== 1) {
				throw new Error(
					"Planned establishment requires exactly one contract"
				);
			}

			var contract = incoming[contracts[0]];

			if (contract.temp === true) {
				throw new Error(
					"Contract forbids persistent establishment"
				);
			}

			if (typeof options.resolveExecutor !== "function") {
				throw new Error(
					"Planned establishment requires an executor resolver"
				);
			}

			executor = contract.executor;
			handler = options.resolveExecutor(executor);
		} else {
			if (
				initial.kind !== "materialized" ||
				!jobState.hasExecutionHeader(initial.fields)
			) {
				throw new Error(
					"Planned reaction requires a materialized JSON job"
				);
			}

			executor = initial.fields["clerus-executor"];
			handler = options.handler;
		}

		if (typeof handler !== "function") {
			throw new Error("Planned reaction requires an available handler");
		}

		if (
			options.acknowledgeResumption === true &&
			(
				establishing ||
				initial.fields["clerus-suspended"] !== "yes" ||
				initial.fields["clerus-custody"] !== options.platform ||
				event.type !== "resumed"
			)
		) {
			throw new Error("Persistent resumption is not authorized");
		}

		scope = plannedScopes.open({
			plan: plan,
			title: options.title,
			platform: options.platform,
			eventType: event.type,
			incoming: incoming,
			newId: options.newId,
			establishing: establishing
		});

		var returned = handler(
			event,
			scope.operational,
			scope.incoming
		);

		if (
			returned !== null &&
			returned !== undefined &&
			typeof returned.then === "function"
		) {
			throw new Error("Executor reactions must be synchronous");
		}

		scope.assertResolved();
		scope.assertOutgoingResolved();

		if (options.acknowledgeResumption === true) {
			var current = plan.read(options.title);

			if (
				current.kind !== "materialized" ||
				current.fields["clerus-custody"] !== options.platform ||
				current.fields["clerus-executor"] !== executor ||
				current.fields["clerus-suspended"] !== "yes"
			) {
				throw new Error(
					"Resumption state changed inside the plan"
				);
			}

			var resumedFields = schemas.copyJSON(current.fields);
			delete resumedFields["clerus-suspended"];

			plan.apply(transitions.transition(
				options.title,
				current.fields,
				resumedFields
			));
		}

		var ownerState = plan.initial(options.title);

		scope.close();
		scope = null;

		return schemas.copyJSON({
			version: 1,
			owner: {
				title: options.title,
				executor: executor,
				state: ownerState
			},
			plan: plan.seal()
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

exports.execute = function (options) {
	return run(options, false);
};

exports.establish = function (options) {
	return run(options, true);
};