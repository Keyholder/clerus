/*\
title: $:/plugins/clerus/core/document-filter.js
type: application/javascript
module-type: clerus-document
\*/

"use strict";

exports.forms = {
	filter: function (access) {
		return Object.freeze({
			titles: function () {
				return access.filterTitles();
			},

			file: function (title, destinationKey) {
				return access.issueTitle(title, destinationKey);
			}
		});
	}
};

exports.rules = {
	filter: {
		transfer: "copy",
		receipt: "automatic",
		messages: ["order", "report"]
	}
};