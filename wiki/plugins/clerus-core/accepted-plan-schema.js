/*\
title: $:/plugins/clerus/core/accepted-plan-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var proposals = require(
	"$:/plugins/clerus/core/proposal-schema.js"
);

/*
Version 1 accepted-plan protocol.

Validation concerns serialized accepted authority, not current
custody, current target state or physical materialization.

allowEmpty supports checking a proposal's material portion
inside a larger accepted obligation.
*/
function validate(record, platform, allowEmpty) {
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

	if (
		proposal.plan.effects.length === 0 &&
		allowEmpty !== true
	) {
		throw new Error("Accepted plan must contain effects");
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

exports.validate = validate;