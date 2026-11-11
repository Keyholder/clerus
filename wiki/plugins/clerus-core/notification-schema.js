/*\
title: $:/plugins/clerus/core/notification-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var missions = require("$:/plugins/clerus/core/mission-schema.js");

function fieldsOnly(value, allowed) {
	if (
		!schemas.isRecord(value) ||
		Object.keys(value).some(function (key) {
			return allowed.indexOf(key) === -1;
		})
	) {
		throw new Error("Unsupported notification fields");
	}
}

function validate(value) {
	var source = schemas.copyJSON(value);
	var mission = source && source.type === "mission-change";

	fieldsOnly(source, mission
		? ["type", "project", "role", "link", "keys"]
		: ["type", "target", "keys"]
	);

	if (
		!Array.isArray(source.keys) ||
		source.keys.length === 0
	) {
		throw new Error("Notification requires document keys");
	}

	source.keys.forEach(function (key) {
		schemas.assertKey(key);
	});

	if (new Set(source.keys).size !== source.keys.length) {
		throw new Error("Notification contains duplicate keys");
	}

	var result = {
		type: source.type,
		keys: source.keys.slice().sort()
	};

	if (mission) {
		var address = missions.validate({
			form: "mission",
			project: source.project,
			role: source.role,
			link: source.link,
			issued: "0",
			children: {}
		});

		result.project = address.project;
		result.role = address.role;
		result.link = address.link;
	} else if (source.type === "document-change") {
		if (!schemas.isOrdinaryTitle(source.target)) {
			throw new Error("Document notification requires an ordinary title");
		}

		result.target = source.target;
	} else if (source.type === "job-status-change") {
		if (!jobTitles.isJobTitle(source.target)) {
			throw new Error("Status notification requires a job title");
		}

		result.target = source.target;
	} else {
		throw new Error("Unsupported notification type");
	}

	return schemas.copyJSON(result);
}

exports.validate = validate;