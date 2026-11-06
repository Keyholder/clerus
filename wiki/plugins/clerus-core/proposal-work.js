/*\
title: $:/plugins/clerus/core/proposal-work.js
type: application/javascript
module-type: library
\*/

"use strict";

var proposals = require(
	"$:/plugins/clerus/core/proposal-schema.js"
);
var works = require(
	"$:/plugins/clerus/core/work-schema.js"
);
var schemas = require("$:/plugins/clerus/core/schemas.js");

function convert(value, id, platform, establishing) {
	var proposal = proposals.validate(value, {
		allowMessages: true,
		allowDeferred: true
	});

	if (
		proposal.owner.state === null &&
		establishing !== true
	) {
		throw new Error(
			"Birth proposal requires an establishing event"
		);
	}

	var emits = proposal.plan.messages.map(function (message) {
		var event = {
			kind: "delivery",
			recipient: message.recipient,
			type: message.type,
			registry: message.registry
		};

		if (message.establishing === true) {
			event.establishing = true;
		}

		if (message.type === "report") {
			event.project = message.project;
			event.role = message.role;
		}

		return {
			id: message.id,
			event: event
		};
	});

	if (proposal.plan.deferred.length !== 0) {
		schemas.assertPlatform(platform);

		proposal.plan.deferred.forEach(function (effect) {
			if (effect.platform !== platform) {
				throw new Error(
					"Cannot convert a foreign deferred effect"
				);
			}

			emits.push({
				id: effect.id,
				event: {
					kind: "activation",
					recipient: effect.recipient
				}
			});
		});
	}

	if (
		proposal.plan.effects.length === 0 &&
		emits.length === 0
	) {
		return null;
	}

	var ownerChanges = proposal.plan.effects.some(
		function (effect) {
			return effect.title === proposal.owner.title;
		}
	);

	return works.validate({
		version: 2,
		id: id,
		checks: ownerChanges
			? []
			: [{
				title: proposal.owner.title,
				state: proposal.owner.state
			}],
		transitions: proposal.plan.effects,
		blocks: [proposal.owner.title],
		emits: emits
	});
}

exports.convert = convert;