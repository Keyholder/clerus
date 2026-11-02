/*\
title: $:/plugins/clerus/core2/documents/mission.js
type: application/javascript
module-type: library
\*/

"use strict";

exports.create = function (access) {
	return Object.freeze({
		inspect: function () {
			return access.inspectMission();
		},

		task: function () {
			var view = access.inspectMission();

			if (!view.readable) {
				throw new Error(
					view.reason || "Task is unavailable"
				);
			}

			return view.task;
		},

		createMission: function (segment, destination, key) {
			return access.issueMission(
				segment,
				destination,
				key
			);
		},

		revokePart: function (segment) {
			access.revokeMission(segment);
		},

		report: function (outgoing) {
			access.sendReport(outgoing);
		}
	});
};