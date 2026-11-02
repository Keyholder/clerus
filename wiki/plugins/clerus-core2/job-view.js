/*\
title: $:/plugins/clerus/core/job-view.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require(
	"$:/plugins/clerus/core/job-titles.js"
);

function read(store, title) {
	if (!jobTitles.isJobTitle(title)) {
		throw new Error("Invalid job title");
	}

	/*
	Infrastructure failures are not malformed job data.
	Do not hide a store.read() exception as unreadability.
	*/
	var stored = store.read(title);

	if (stored.kind === "absent") {
		return {
			exists: false,
			readable: false,
			status: null,
			reason: "Job does not exist"
		};
	}

	var result = {
		exists: true,
		readable: false,
		status: null,
		reason: null
	};

	try {
		if (stored.kind !== "materialized") {
			throw new Error("Job must be materialized");
		}

		if (stored.fields.type !== "application/json") {
			throw new Error("Job must have type application/json");
		}

		var registry = JSON.parse(stored.fields.text);

		if (!schemas.isRecord(registry)) {
			throw new Error("Job registry must be a JSON record");
		}

		var charters = Object.keys(registry).map(function (key) {
			return registry[key];
		}).filter(function (document) {
			return schemas.isRecord(document) &&
				document.form === "charter";
		});

		if (charters.length !== 1) {
			throw new Error("Job must contain exactly one charter");
		}

		var charter = schemas.document(charters[0]);

		result.status = charter.status;
		result.readable = true;
	} catch (error) {
		result.reason = String(error.message);
	}

	return result;
}

exports.read = read;