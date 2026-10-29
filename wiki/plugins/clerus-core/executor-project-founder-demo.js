/*\
title: $:/plugins/clerus/core/executor-project-founder-demo.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

exports.name = "project-founder-demo";

function react(event, operational) {
	if (event.type !== "ready") {
		return;
	}

	var mission = operational.get("mission");

	mission.createPart("worker", {
		message: "Delegated task"
	});

	mission.createMission("worker", "childMission");

	var subordinate = operational.get("charter").createTitle(
		"worker",
		"subordinate"
	);

	subordinate.order("mandate", "childMission");

	operational.get("charter").setStatus({
		phase: "delegated"
	});
}

exports.browser = react;
exports.node = react;