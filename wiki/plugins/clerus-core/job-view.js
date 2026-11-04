/*\
title: $:/plugins/clerus/core/job-view.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobState = require("$:/plugins/clerus/core/job-state.js");

function read(store, title) {
	/*
	Source failures and source contract violations must propagate.
	They are not malformed job data.
	*/
	var state = jobState.read(store, title);

	var result = {
		exists: state.kind !== "absent",
		readable: false,
		status: null,
		reason: state.reason
	};

	if (state.kind !== "ready") {
		return result;
	}

	try {
		var charters = Object.keys(state.registry).map(function (key) {
			return state.registry[key];
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
		result.reason = null;
	} catch (error) {
		result.reason = String(error.message);
	}

	return result;
}

exports.read = read;