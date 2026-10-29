/*\
title: $:/plugins/clerus/demo/openrouter-session-executor.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

exports.name = "clerus-openrouter-session-demo";

exports.node = function (event, operational) {
	if (event.type !== "ready" && event.type !== "tick") {
		return;
	}

	var session = operational.get("session");
	var charter = operational.get("charter");
	var state = session.inspect();

	if (state.phase === "waiting") {
		session.receive();
		state = session.inspect();
	}

	if (state.phase === "failed" || state.phase === "uncertain") {
		charter.setStatus({
			phase: state.phase,
			error: state.error
		});
		return;
	}

	if (state.phase !== "ready") {
		return;
	}

	if (state.messages.length === 0) {
		session.send(
			"Объясни назначение write-ahead log в трёх предложениях."
		);
		charter.setStatus({ phase: "first-question" });
		return;
	}

	if (state.messages.length === 2) {
		session.send(
			"Теперь проиллюстрируй предыдущее объяснение одним " +
			"конкретным примером сбоя между двумя записями."
		);
		charter.setStatus({ phase: "followup" });
		return;
	}

	charter.setStatus({
		phase: "completed",
		messages: state.messages
	});
};