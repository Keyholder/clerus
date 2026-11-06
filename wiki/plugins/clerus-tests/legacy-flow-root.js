/*\
title: $:/plugins/clerus/tests/legacy-flow-root.js
type: application/javascript
module-type: library
\*/

"use strict";

var planned = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
var flows = require(
	"$:/plugins/clerus/core/flow-obligations.js"
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

	var manager = flows.create({
		store: options.store,
		platform: options.platform,
		newId: options.newId
	});

	var title = manager.register(proposal);
	var pending = manager.resume(title);

	return {
		status: "completed",
		obligation: title,
		results: [],
		pending: pending
	};
}

exports.start = start;