/*\
title: $:/plugins/clerus/core2/documents/job-title.js
type: application/javascript
module-type: library
\*/

"use strict";

exports.create = function (access) {
	return Object.freeze({
		inspect: function () {
			return access.inspectJob();
		},

		status: function () {
			var view = access.inspectJob();

			if (!view.readable) {
				throw new Error(
					view.reason || "Job status is unavailable"
				);
			}

			return view.status;
		},

		order: function (outgoing) {
			access.sendOrder(outgoing);
		}
	});
};