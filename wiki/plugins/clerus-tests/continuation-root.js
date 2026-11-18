/*\
title: $:/plugins/clerus/tests/continuation-root.js
type: application/javascript
module-type: library
\*/

"use strict";

var planned = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
var continuations = require(
	"$:/plugins/clerus/core/continuations.js"
);
var proposalWork = require(
	"$:/plugins/clerus/core/proposal-work.js"
);

function start(options) {
	var proposal = planned.execute({
		store: options.store,
		title: options.title,
		platform: options.platform,
		event: options.event,
		handler: options.handler,
		newId: options.newId
	});

	var work = proposalWork.convert(
		proposal,
		options.newId(),
		options.platform
	);

	if (work === null) {
		return {
			status: "completed",
			obligation: null,
			results: [],
			pending: []
		};
	}

	var manager = continuations.create({
		store: options.store,
		platform: options.platform,
		newId: options.newId
	});

	var title = manager.accept(work);
	var results = manager.resume(title);
	var remaining = options.store.read(title);
	var pending = [];

	if (
		remaining.kind === "materialized" &&
		remaining.fields["clerus-custody"] === options.platform
	) {
		pending = manager.pending(title).map(function (entry) {
			return Object.assign(
				{ id: entry.id },
				entry.event
			);
		});
	}

	return {
		status: "completed",
		obligation: title,
		results: results,
		pending: pending
	};
}

exports.start = start;