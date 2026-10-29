/*\
title: $:/plugins/clerus/demo/openrouter-executor.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

exports.name = "clerus-openrouter-demo";

exports.node = function (event, operational) {
	var call = operational.get("call");
	var view = call.inspect();
	var charter = operational.get("charter");

	if (event.type === "ready" && view.phase === "idle") {
		var instruction = charter.book();

		call.submit({
			model: instruction.model,
			messages: [{
				role: "user",
				content: instruction.prompt
			}],
			max_tokens: 1024
		});

		charter.setStatus({
			phase: "waiting"
		});

		return;
	}

	if (event.type !== "tick") {
		return;
	}

	if (view.phase === "completed") {
		charter.setStatus({
			phase: "completed",
			text: view.response.choices[0].message.content,
			model: view.response.model || null,
			usage: view.response.usage || null
		});
	} else if (
		view.phase === "failed" ||
		view.phase === "uncertain"
	) {
		charter.setStatus({
			phase: view.phase,
			error: view.error
		});
	}
};