/*\
title: $:/plugins/clerus/demo/project-editor-executor.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

var wikiTools =
	require("$:/plugins/clerus/core/agent-wiki-tools.js");

function sameTask(left, right) {
	// Conservative comparison: even a serialization-order change may
	// require operator review, but cannot silently replace the task.
	return JSON.stringify(left) === JSON.stringify(right);
}

exports.name = "clerus-project-editor-demo";

exports.node = function (event, operational) {
	if (
		event.type !== "ready" &&
		event.type !== "tick" &&
		!(
			event.type === "document-change" &&
			event.key === "mission"
		)
	) {
		return;
	}

	var charter = operational.get("charter");
	var mission = operational.get("mission");
	var workMemo = operational.get("work");
	var work = workMemo.data();

	// Finished is authoritative in this executor's own memo.
	if (work.phase === "finished") {
		return;
	}

	var assignment = mission.inspect();

	if (!assignment.active || !assignment.readable) {
		charter.setStatus({
			phase: "assignment-unavailable",
			reason: assignment.reason || "Assignment is inactive"
		});
		return;
	}

	var task = mission.task();

	if (
		!task ||
		typeof task !== "object" ||
		Array.isArray(task) ||
		typeof task.prompt !== "string" ||
		!task.prompt.trim()
	) {
		charter.setStatus({
			phase: "invalid-task"
		});
		return;
	}

	if (work.phase === "idle") {
		work = {
			phase: "working",
			task: task,
			toolRounds: 0
		};

		workMemo.setData(work);
	} else if (!sameTask(work.task, task)) {
		charter.setStatus({
			phase: "task-changed",
			message: "Accepted task differs from the current assignment"
		});
		return;
	}

	var session = operational.get("session");
	var view = session.inspect();

	if (view.phase === "waiting") {
		session.receive();
		view = session.inspect();
	}

	function finish(result) {
		operational.get("result").setData(result);

		// Copy the result memo, preserving the addressing assignment.
		mission.report({
			result: "result"
		});

		work.phase = "finished";
		workMemo.setData(work);

		charter.setStatus({
			phase: result.ok ? "completed" : "failed",
			toolRounds: work.toolRounds
		});
	}

	if (view.phase === "failed" || view.phase === "uncertain") {
		finish({
			ok: false,
			outcome: view.phase,
			error: view.error
		});
		return;
	}

	if (view.phase === "tools") {
		var calls = view.messages[view.messages.length - 1].tool_calls;

		if (work.toolRounds >= 6 || calls.length > 8) {
			finish({
				ok: false,
				outcome: "tool-limit",
				toolRounds: work.toolRounds
			});
			return;
		}

		var results = wikiTools.execute(calls, operational, {
			documentKey: "document",
			warrantKey: "permission"
		});

		session.resolveTools(results);

		work.toolRounds++;
		workMemo.setData(work);

		charter.setStatus({
			phase: "working",
			toolRounds: work.toolRounds
		});
		return;
	}

	if (view.phase !== "ready") {
		return;
	}

	if (view.messages.length === 0) {
		session.send(work.task.prompt);

		charter.setStatus({
			phase: "working",
			toolRounds: 0
		});
		return;
	}

	finish({
		ok: true,
		answer: view.messages[view.messages.length - 1].content,
		toolRounds: work.toolRounds
	});
};