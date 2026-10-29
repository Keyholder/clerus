/*\
title: $:/plugins/clerus/demo/project-director-executor.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

exports.name = "clerus-project-director-demo";

exports.node = function (event, operational, incoming) {
	if (event.type !== "report") {
		return;
	}

	if (
		event.role.length !== 1 ||
		event.role[0] !== "edit"
	) {
		throw new Error("Unexpected report role");
	}

	var result = incoming.get("result").data();

	// The director already has its own result memo.
	operational.get("result").setData(result);

	operational.get("charter").setStatus({
		phase: result.ok ? "completed" : "failed",
		result: result
	});
};