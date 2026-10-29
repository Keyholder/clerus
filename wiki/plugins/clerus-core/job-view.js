/*\
title: $:/plugins/clerus/core/job-view.js
type: application/javascript
module-type: library
\*/

"use strict";

function isJobTitle(title) {
	return typeof title === "string" && (
		title.indexOf("$:/clerus/jobs/") === 0 ||
		title.indexOf("$:/temp/clerus/jobs/browser/") === 0 ||
		title.indexOf("$:/temp/clerus/jobs/node/") === 0
	);
}

function readJob(wiki, title) {
	var tiddler = wiki.getTiddler(title);

	if (!tiddler) {
		return {
			exists: false,
			readable: false,
			status: null
		};
	}

	try {
		if (tiddler.fields.type !== "application/json") {
			throw new Error("Not a JSON job");
		}

		var registry = JSON.parse(tiddler.fields.text);

		if (
			registry === null ||
			typeof registry !== "object" ||
			Array.isArray(registry)
		) {
			throw new Error("Invalid registry");
		}

		var charters = Object.keys(registry).map(function (key) {
			return registry[key];
		}).filter(function (document) {
			return document !== null &&
				typeof document === "object" &&
				!Array.isArray(document) &&
				document.form === "charter";
		});

		if (
			charters.length !== 1 ||
			!Object.prototype.hasOwnProperty.call(charters[0], "status")
		) {
			throw new Error("Invalid charter");
		}

		return {
			exists: true,
			readable: true,
			status: charters[0].status
		};
	} catch (error) {
		return {
			exists: true,
			readable: false,
			status: null
		};
	}
}

exports.isJobTitle = isJobTitle;
exports.readJob = readJob;