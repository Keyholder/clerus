/*\
title: $:/plugins/clerus/tests/observation-executor.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

function react(event, operational) {
	if (event.type !== "document-change") {
		throw new Error("Unexpected observation test event");
	}

	var charter = operational.get("charter");

	charter.setStatus({
		count: charter.status().count + 1,
		text: operational.get(event.keys[0]).text()
	});
}

exports.browser = react;
exports.node = react;