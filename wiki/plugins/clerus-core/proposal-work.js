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

function convert(value, id) {
	var proposal = proposals.validate(value, {
		allowMessages: true,
		allowDeferred: true
	});

	if (proposal.owner.state === null) {
		throw new Error(
			"Birth proposal requires establishing-event support"
		);
	}

	if (proposal.plan.deferred.length !== 0) {
		throw new Error(
			"Deferred proposal requires activation support"
		);
	}

	var emits = proposal.plan.messages.map(function (message) {
		if (message.establishing === true) {
			throw new Error(
				"Establishing message requires establishment support"
			);
		}

		var event = {
			kind: "delivery",
			recipient: message.recipient,
			type: message.type,
			registry: message.registry
		};

		if (message.type === "report") {
			event.project = message.project;
			event.role = message.role;
		}

		return {
			id: message.id,
			event: event
		};
	});

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