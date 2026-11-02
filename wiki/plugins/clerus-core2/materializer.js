/*\
title: $:/plugins/clerus/core2/materializer.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var proposals = require(
	"$:/plugins/clerus/core2/proposal-schema.js"
);

function equal(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function validate(record, platform) {
	schemas.assertPlatform(platform);

	var value = schemas.copyJSON(record);

	if (
		!schemas.isRecord(value) ||
		Object.keys(value).some(function (key) {
			return [
				"version",
				"kind",
				"platform",
				"proposal"
			].indexOf(key) === -1;
		}) ||
		value.version !== 1 ||
		value.kind !== "plan" ||
		value.platform !== platform
	) {
		throw new Error("Invalid accepted-plan record");
	}

	var proposal = proposals.validate(value.proposal);

	if (proposal.plan.effects.length === 0) {
		throw new Error("Accepted plan must contain effects");
	}

	if (
		proposal.owner.state["clerus-custody"] !== platform
	) {
		throw new Error("Invalid accepted owner authority");
	}

	proposal.plan.effects.forEach(function (effect) {
		if (
			effect.before !== null &&
			effect.before["clerus-custody"] !== platform
		) {
			throw new Error("Invalid accepted target authority");
		}

		if (
			effect.before === null &&
			effect.after["clerus-custody"] !== platform
		) {
			throw new Error("Invalid accepted creation authority");
		}
	});

	return {
		version: 1,
		kind: "plan",
		platform: platform,
		proposal: proposal
	};
}

function execute(options) {
	var record = validate(options.record, options.platform);
	var proposal = record.proposal;
	var store = options.store;

	var owner = store.read(proposal.owner.title);

	var ownerEffect = proposal.plan.effects.find(function (effect) {
		return effect.title === proposal.owner.title;
	});

	if (
		owner.kind !== "materialized" ||
		(
			!equal(owner.fields, proposal.owner.state) &&
			!(
				ownerEffect &&
				equal(owner.fields, ownerEffect.after)
			)
		)
	) {
		throw new Error("Accepted plan owner state has changed");
	}

	var shadowTitles = new Set(
		store.snapshot().shadows.map(function (fields) {
			return fields.title;
		})
	);

	/*
		Check the whole set before performing any further write.
		Already materialized effects remain acceptable.
	*/
	proposal.plan.effects.forEach(function (effect) {
		if (shadowTitles.has(effect.title)) {
			throw new Error("Accepted target is shadow-backed");
		}

		store.check(effect);
	});

	return proposal.plan.effects.map(function (effect) {
		return store.apply(effect);
	});
}

exports.validate = validate;
exports.execute = execute;