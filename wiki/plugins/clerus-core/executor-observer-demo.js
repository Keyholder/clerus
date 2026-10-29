/*\
title: $:/plugins/clerus/core/executor-observer-demo.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

exports.name = "observer-demo";

function react(event, context) {
	if (event.type === "dismissed") {
		return;
	}

	if (
		event.type !== "ready" &&
		!(event.type === "document-change" && event.key === "target")
	) {
		return;
	}

	var target = context.get("target");
	var history = context.get("history");
	var data = history.data();

	data.push({
		event: event.type,
		view: target.inspect()
	});

	history.setData(data);

	console.log("[Clerus observer]", data);
}

exports.browser = react;
exports.node = react;