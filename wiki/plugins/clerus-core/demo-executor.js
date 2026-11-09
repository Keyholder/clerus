/*\
title: $:/plugins/clerus/core/demo-executor.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

function react(event, operational, incoming) {
	if (
		event.type === "suspended" ||
		event.type === "resumed"
	) {
		return;
	}

	if (event.type === "order") {
		var contract = incoming.get("contract");
		var book = contract.book();

		if (
			!book ||
			!Number.isInteger(book.steps) ||
			book.steps < 1 ||
			book.steps > 100
		) {
			throw new Error("Demo requires steps between 1 and 100");
		}

		contract.accept("charter", {
			phase: "waiting",
			completed: 0
		});

		operational.get("charter").defer();
		return;
	}

	if (event.type === "tick") {
		var charter = operational.get("charter");
		var steps = charter.book().steps;
		var completed = charter.status().completed + 1;

		charter.setStatus({
			phase: completed < steps ? "waiting" : "completed",
			completed: completed
		});

		if (completed < steps) {
			charter.defer();
		}

		return;
	}

	throw new Error("Unsupported demo event: " + event.type);
}

exports.browser = react;
exports.node = react;