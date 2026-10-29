/*\
title: $:/plugins/clerus/core/executor-demo.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

exports.name = "demo";

function react(event, context) {
	var charter = context.get("charter");

	if (event.type === "dismissed") {
		console.log("[Clerus demo dismissed]", charter.status());

		// Read-only context: this must fail.
		try {
			charter.setStatus({ phase: "still-working" });
		} catch (error) {
			console.log("[Clerus expected refusal]", error.message);
		}

		return;
	}

	if (event.type !== "ready" && event.type !== "order") {
		return;
	}

	charter.setStatus({
		phase: "started",
		platform: event.platform
	});

	var book = charter.book();

	if (book && book.failOnReady) {
		throw new Error("Deliberate demo failure");
	}

	charter.setStatus({
		phase: "ready",
		platform: event.platform
	});
}

exports.browser = react;
exports.node = react;