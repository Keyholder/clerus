/*\
title: $:/plugins/clerus/tests/protocol-observation.js
type: application/javascript
module-type: library
\*/

"use strict";

/*
Attempt reports from the two dispatchers.

These arrays describe attempts, not authoritative outstanding work.
*/
function attempts(report) {
	var result = {
		completed: (report.completed || []).slice(),
		blocked: (report.blocked || []).slice(),
		unavailable: (report.unavailable || []).slice(),
		errors: (report.errors || []).slice()
	};

	(report.continuations || []).forEach(function (pass) {
		Object.keys(result).forEach(function (name) {
			result[name] = result[name].concat(
				pass[name] || []
			);
		});
	});

	return result;
}

function pendingDeliveryIds(wiki, title) {
	var tiddler = wiki.getTiddler(title);

	if (!tiddler) {
		return [];
	}

	var record = JSON.parse(tiddler.fields.text);

	if (record.version === 1 && record.kind === "flow") {
		return record.pending.map(function (message) {
			return message.id;
		}).sort();
	}

	if (
		record.version === 2 &&
		record.kind === "continuation"
	) {
		return Object.keys(record.events).filter(function (id) {
			return (
				record.events[id].event.kind === "delivery"
			);
		}).sort();
	}

	throw new Error("Expected a supported event journal");
}

exports.attempts = attempts;
exports.pendingDeliveryIds = pendingDeliveryIds;