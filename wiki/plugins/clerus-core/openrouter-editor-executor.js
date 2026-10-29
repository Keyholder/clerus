/*\
title: $:/plugins/clerus/demo/openrouter-editor-executor.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

var wikiTools =
	require("$:/plugins/clerus/core/agent-wiki-tools.js");

exports.name = "clerus-openrouter-editor-demo";

exports.node = function (event, operational) {
	if (event.type !== "ready" && event.type !== "tick") {
		return;
	}

	var charter = operational.get("charter");
	var instruction = charter.book();
	var session = operational.get("session");
	var view = session.inspect();
	var status = charter.status();

	if (view.phase === "waiting") {
		session.receive();
		view = session.inspect();
	}

	if (view.phase === "failed" || view.phase === "uncertain") {
		charter.setStatus({
			phase: view.phase,
			error: view.error,
			toolRounds: status.toolRounds || 0
		});
		return;
	}

	if (view.phase === "tools") {
		var rounds = status.toolRounds || 0;

		if (rounds >= 6) {
			charter.setStatus({
				phase: "tool-limit",
				toolRounds: rounds
			});
			return;
		}

		var calls = view.messages[view.messages.length - 1].tool_calls;

		if (calls.length > 8) {
			charter.setStatus({
				phase: "tool-batch-limit",
				toolRounds: rounds
			});
			return;
		}

		var results = wikiTools.execute(calls, operational, {
			documentKey: "document",
			warrantKey: "permission"
		});

		session.resolveTools(results);

		charter.setStatus({
			phase: "waiting",
			toolRounds: rounds + 1
		});
		return;
	}

	if (view.phase !== "ready") {
		return;
	}

	if (view.messages.length === 0) {
		session.send(instruction.prompt);

		charter.setStatus({
			phase: "waiting",
			toolRounds: 0
		});
		return;
	}

	charter.setStatus({
		phase: "completed",
		toolRounds: status.toolRounds || 0,
		answer: view.messages[view.messages.length - 1].content
	});
};