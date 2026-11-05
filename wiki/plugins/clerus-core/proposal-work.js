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

	if (
		proposal.plan.messages.length !== 0 ||
		proposal.plan.deferred.length !== 0
	) {
		throw new Error(
			"Event-bearing proposal requires event support"
		);
	}

	/*
		An empty material reaction creates no new obligation.
		Consumption of an incoming event is a separate protocol.
	*/
	if (proposal.plan.effects.length === 0) {
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
		emits: []
	});
}

exports.convert = convert;