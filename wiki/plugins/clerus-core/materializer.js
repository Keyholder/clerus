/*\
title: $:/plugins/clerus/core/materializer.js
type: application/javascript
module-type: library
\*/

"use strict";

var acceptedPlans = require(
	"$:/plugins/clerus/core/accepted-plan-schema.js"
);

var validate = acceptedPlans.validate;

function equal(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function check(options) {
	var record = validate(
		options.record,
		options.platform,
		options.allowEmpty
	);

	var proposal = record.proposal;
	var store = options.store;
	var owner = store.read(proposal.owner.title);

	var ownerEffect = proposal.plan.effects.find(function (effect) {
		return effect.title === proposal.owner.title;
	});

	var atBaseline = proposal.owner.state === null
		? owner.kind === "absent"
		: owner.kind === "materialized" &&
			equal(owner.fields, proposal.owner.state);

	var atFinal = ownerEffect !== undefined &&
		owner.kind === "materialized" &&
		equal(owner.fields, ownerEffect.after);

	if (!atBaseline && !atFinal) {
		throw new Error("Accepted plan owner state has changed");
	}

	var shadowTitles = new Set(
		store.snapshot().shadows.map(function (fields) {
			return fields.title;
		})
	);

	proposal.plan.effects.forEach(function (effect) {
		if (shadowTitles.has(effect.title)) {
			throw new Error("Accepted target is shadow-backed");
		}

		store.check(effect);
	});

	return record;
}

function execute(options) {
	var record = check(options);

	return record.proposal.plan.effects.map(function (effect) {
		return options.store.apply(effect);
	});
}

exports.validate = validate;
exports.check = check;
exports.execute = execute;