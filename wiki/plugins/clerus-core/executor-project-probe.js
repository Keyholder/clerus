/*\
title: $:/plugins/clerus/core/executor-project-probe.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

exports.name = "clerus-project-probe";

exports.browser = function (event, operational) {
	if (
		event.type !== "ready" &&
		event.type !== "resumed" &&
		!(
			event.type === "document-change" &&
			event.key === "mission"
		)
	) {
		return;
	}

	var charter = operational.get("charter");
	var workMemo = operational.get("work");
	var work = workMemo.data();

	if (work.phase === "finished") {
		return;
	}

	var mission = operational.get("mission");
	var view = mission.inspect();

	if (!view.active || !view.readable) {
		charter.setStatus({
			phase: "assignment-unavailable",
			reason: view.reason
		});
		return;
	}

	var task = mission.task();

	if (
		!task ||
		typeof task.prompt !== "string" ||
		!task.prompt.trim()
	) {
		charter.setStatus({
			phase: "invalid-task"
		});
		return;
	}

	workMemo.setData({
		phase: "finished",
		task: task
	});

	charter.setStatus({
		phase: "completed",
		message: "Проект принят браузерным рантаймом.",
		prompt: task.prompt
	});
};