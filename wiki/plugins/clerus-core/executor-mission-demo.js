/*\
title: $:/plugins/clerus/core/executor-mission-demo.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

exports.name = "mission-demo";

function react(event, operational) {
	if (
		event.type !== "ready" &&
		event.type !== "order" &&
		!(
			event.type === "document-change" &&
			event.key === "mission"
		)
	) {
		return;
	}

	var view = operational.get("mission").inspect();

	operational.get("charter").setStatus({
		phase: view.readable ? "assigned" : "blocked",
		task: view.task,
		reason: view.reason
	});
}

exports.browser = react;
exports.node = react;