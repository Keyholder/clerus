/*\
title: $:/plugins/clerus/core/work-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var stores = require("$:/plugins/clerus/core/store.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var events = require("$:/plugins/clerus/core/event-schema.js");
var custodySchema = require(
	"$:/plugins/clerus/core/custody-schema.js"
);

var hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);

function fieldsOnly(record, allowed, description) {
	if (
		!schemas.isRecord(record) ||
		Object.keys(record).some(function (key) {
			return allowed.indexOf(key) === -1;
		})
	) {
		throw new Error("Unsupported fields in " + description);
	}
}

function identity(value) {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9_-]{16,128}$/.test(value)
	) {
		throw new Error("Invalid work identity");
	}

	return value;
}

function target(title) {
	if (schemas.isOrdinaryTitle(title)) {
		return "ordinary";
	}

	var space = jobTitles.classify(title);

	if (space && space.persistent) {
		return "job";
	}

	throw new Error("Unsupported material work target");
}

function persistentJob(title) {
	var space = jobTitles.classify(title);

	if (!space || !space.persistent) {
		throw new Error("Work block requires a persistent job title");
	}

	return title;
}

function snapshot(title, value) {
	if (value === null) {
		return null;
	}

	return stores.transition(title, value, value).after;
}

function validateJobTransition(effect, workId) {
	if (effect.after === null) {
		throw new Error(
			"Job deletion is not supported by material work yet"
		);
	}

	var before = effect.before;
	var after = effect.after;

	if (
		after.type !== "application/json" ||
		typeof after["clerus-executor"] !== "string" ||
		after["clerus-executor"].length === 0 ||
		typeof after.text !== "string"
	) {
		throw new Error("Invalid final job header");
	}

	if (before === null) {
		if (
			Object.prototype.hasOwnProperty.call(
				after,
				custodySchema.TRANSFER_FIELD
			)
		) {
			throw new Error(
				"A new job cannot start with a relocation marker"
			);
		}
	} else {
		/*
			A retained marker remains protocol data even when
			only the operational registry changes.
		*/
		custodySchema.readTransfer(after);
	}

	if (before !== null) {
		if (
			typeof before["clerus-executor"] !== "string" ||
			before["clerus-executor"].length === 0 ||
			after["clerus-executor"] !==
				before["clerus-executor"]
		) {
			throw new Error(
				"Material work cannot change job executor"
			);
		}

		var changingCustody = (
			before["clerus-custody"] !==
				after["clerus-custody"]
		);

		if (changingCustody) {
			var marker = custodySchema.readTransfer(after);

			if (
				marker === null ||
				marker.work !== workId ||
				marker.from !== before["clerus-custody"] ||
				marker.to !== after["clerus-custody"]
			) {
				throw new Error(
					"Job custody changes require a bound relocation marker"
				);
			}
		} else if (
			before[custodySchema.TRANSFER_FIELD] !==
				after[custodySchema.TRANSFER_FIELD]
		) {
			throw new Error(
				"Material work cannot rewrite an existing transfer marker"
			);
		}
	}

	var registry;

	try {
		registry = JSON.parse(after.text);
	} catch (error) {
		throw new Error("Invalid final job registry JSON");
	}

	schemas.registry(registry, "operational");
}

function validate(value) {
	var work = schemas.copyJSON(value);

	fieldsOnly(work, [
		"version", "id", "checks", "transitions", "blocks", "emits"
	], "work");

	if (
		work.version !== 2 ||
		!Array.isArray(work.checks) ||
		!Array.isArray(work.transitions) ||
		!Array.isArray(work.blocks) ||
		!Array.isArray(work.emits)
	) {
		throw new Error("Invalid material work");
	}

	identity(work.id);

	if (
		work.transitions.length === 0 &&
		work.emits.length === 0
	) {
		throw new Error("Work must contain transitions or emissions");
	}

	var targets = new Set();

	var transitions = work.transitions.map(function (value) {
		fieldsOnly(value, [
			"version", "title", "before", "after"
		], "work transition");

		if (
			value.version !== 1 ||
			!hasOwn(value, "before") ||
			!hasOwn(value, "after")
		) {
			throw new Error("Invalid work transition");
		}

		var kind = target(value.title);
		var effect = stores.transition(
			value.title,
			value.before,
			value.after
		);

		if (targets.has(effect.title)) {
			throw new Error("Repeated work transition target");
		}

		targets.add(effect.title);

		if (kind === "job") {
			validateJobTransition(effect, work.id);
		}

		return effect;
	});

	var checked = new Set();

	var checks = work.checks.map(function (value) {
		fieldsOnly(value, ["title", "state"], "work check");

		if (!hasOwn(value, "state")) {
			throw new Error("Work check must contain state");
		}

		target(value.title);

		if (checked.has(value.title)) {
			throw new Error("Repeated work check target");
		}

		if (targets.has(value.title)) {
			throw new Error(
				"Work check overlaps a transition target"
			);
		}

		checked.add(value.title);

		return {
			title: value.title,
			state: snapshot(value.title, value.state)
		};
	});

	var blocked = new Set();

	var blocks = work.blocks.map(function (title) {
		persistentJob(title);

		if (blocked.has(title)) {
			throw new Error("Repeated work block");
		}

		blocked.add(title);
		return title;
	});

	var emitted = new Set();

	var emits = work.emits.map(function (value) {
		var effect = events.emission(value);

		if (emitted.has(effect.id)) {
			throw new Error("Repeated emitted event identity");
		}

		emitted.add(effect.id);
		return effect;
	});

	return schemas.copyJSON({
		version: 2,
		id: work.id,
		checks: checks,
		transitions: transitions,
		blocks: blocks,
		emits: emits
	});
}

function canonical(value) {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}

	if (schemas.isRecord(value)) {
		var result = Object.create(null);

		Object.keys(value).sort().forEach(function (key) {
			Object.defineProperty(result, key, {
				value: canonical(value[key]),
				enumerable: true,
				writable: true,
				configurable: true
			});
		});

		return result;
	}

	return value;
}

/*
An immutable-content fingerprint, not proof of acceptance
or successful execution.

Transition order remains significant.
*/
function fingerprint(value) {
	return JSON.stringify(canonical(validate(value)));
}

exports.validate = validate;
exports.fingerprint = fingerprint;