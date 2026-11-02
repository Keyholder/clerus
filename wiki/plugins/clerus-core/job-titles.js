/*\
title: $:/plugins/clerus/core/job-titles.js
type: application/javascript
module-type: library
\*/

"use strict";

var SPACES = [
	{
		prefix: "$:/clerus/jobs/",
		persistent: true,
		platform: null
	},
	{
		prefix: "$:/temp/clerus/jobs/browser/",
		persistent: false,
		platform: "browser"
	},
	{
		prefix: "$:/temp/clerus/jobs/node/",
		persistent: false,
		platform: "node"
	}
];

function classify(title) {
	if (typeof title !== "string") {
		return null;
	}

	for (var index = 0; index < SPACES.length; index++) {
		var space = SPACES[index];

		if (
			title.indexOf(space.prefix) === 0 &&
			title.length > space.prefix.length
		) {
			return Object.freeze({
				prefix: space.prefix,
				persistent: space.persistent,
				platform: space.platform
			});
		}
	}

	return null;
}

function isJobTitle(title) {
	return classify(title) !== null;
}

exports.classify = classify;
exports.isJobTitle = isJobTitle;