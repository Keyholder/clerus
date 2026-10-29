/*\
title: $:/plugins/clerus/core/executor-receiver-demo.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

exports.name = "receiver-demo";

function react(event, operational, incoming) {
	if (event.type !== "order" || !incoming) {
		return;
	}

	var received = incoming.get("note").file("receivedNote");

	operational.get("charter").setStatus({
		phase: "received",
		data: received.data()
	});
}

exports.browser = react;
exports.node = react;