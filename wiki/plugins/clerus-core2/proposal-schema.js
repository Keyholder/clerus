/*\
title: $:/plugins/clerus/core2/proposal-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var stores = require("$:/plugins/clerus/core2/store.js");

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

function normalizeFields(fields) {
	if (!schemas.isRecord(fields)) {
		throw new Error("Expected tiddler fields");
	}

	return stores.transition(
		fields.title,
		fields,
		fields
	).after;
}

function validate(value) {
	var proposal = schemas.copyJSON(value);

	fieldsOnly(
		proposal,
		["version", "owner", "plan"],
		"proposal"
	);

	fieldsOnly(
		proposal.owner,
		["title", "executor", "state"],
		"proposal owner"
	);

	fieldsOnly(
		proposal.plan,
		["version", "effects"],
		"proposal plan"
	);

	if (
		proposal.version !== 1 ||
		proposal.plan.version !== 1 ||
		typeof proposal.owner.title !== "string" ||
		proposal.owner.title.indexOf("$:/clerus/jobs/") !== 0 ||
		proposal.owner.title.length === "$:/clerus/jobs/".length ||
		typeof proposal.owner.executor !== "string" ||
		proposal.owner.executor.length === 0 ||
		!Array.isArray(proposal.plan.effects)
	) {
		throw new Error("Invalid work proposal");
	}

	var state = normalizeFields(proposal.owner.state);

	if (
		state.title !== proposal.owner.title ||
		state.type !== "application/json" ||
		state["clerus-executor"] !== proposal.owner.executor
	) {
		throw new Error("Invalid proposal owner baseline");
	}

	schemas.registry(JSON.parse(state.text), "operational");

	var seen = new Set();

	var effects = proposal.plan.effects.map(function (value) {
		fieldsOnly(
			value,
			["version", "title", "before", "after"],
			"material transition"
		);

		if (value.version !== 1) {
			throw new Error("Invalid material transition version");
		}

		var effect = stores.transition(
			value.title,
			value.before,
			value.after
		);

		if (seen.has(effect.title)) {
			throw new Error("Repeated proposal target");
		}

		seen.add(effect.title);

		if (effect.title === proposal.owner.title) {
			if (
				effect.before === null ||
				effect.after === null ||
				JSON.stringify(effect.before) !== JSON.stringify(state) ||
				effect.after.type !== "application/json" ||
				effect.after["clerus-executor"] !== proposal.owner.executor
			) {
				throw new Error("Invalid proposal owner transition");
			}

			schemas.registry(
				JSON.parse(effect.after.text),
				"operational"
			);
		} else if (!schemas.isOrdinaryTitle(effect.title)) {
			throw new Error(
				"External proposal target must be an ordinary tiddler"
			);
		}

		return effect;
	});

	return schemas.copyJSON({
		version: 1,
		owner: {
			title: proposal.owner.title,
			executor: proposal.owner.executor,
			state: state
		},
		plan: {
			version: 1,
			effects: effects
		}
	});
}

exports.validate = validate;