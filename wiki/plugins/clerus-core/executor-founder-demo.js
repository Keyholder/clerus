/*\
title: $:/plugins/clerus/core/executor-founder-demo.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

exports.name = "founder-demo";

function react(event, context) {
	if (event.type !== "ready") {
		return;
	}

	var charter = context.get("charter");
	var subordinate = charter.createTitle("worker", "subordinate");

	subordinate.order("mandate");

	subordinate.order({
		note: "workingNote"
	});

	charter.setStatus({
		phase: "delegated"
	});
}

exports.browser = react;
exports.node = react;