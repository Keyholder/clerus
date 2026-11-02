/*\
title: $:/plugins/clerus/core/incidents.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var transitions = require("$:/plugins/clerus/core/store.js");

function create(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.store.read !== "function" ||
		typeof options.store.apply !== "function" ||
		typeof options.newId !== "function"
	) {
		throw new Error("Incident recorder requires a store and identity source");
	}

	var used = new Set();
	var prefix = "$:/clerus/wal/" + options.platform + "/incident-";

	function record(value) {
		var incident = schemas.copyJSON(value);

		if (
			!schemas.isRecord(incident) ||
			incident.kind !== "executor-failure" ||
			incident.platform !== options.platform ||
			!schemas.isRecord(incident.owner) ||
			typeof incident.owner.title !== "string" ||
			typeof incident.owner.executor !== "string" ||
			!schemas.isRecord(incident.event) ||
			!schemas.isRecord(incident.error)
		) {
			throw new Error("Invalid executor incident");
		}

		var id = options.newId();

		if (
			typeof id !== "string" ||
			!/^[A-Za-z0-9_-]{16,128}$/.test(id)
		) {
			throw new Error("Invalid incident identifier");
		}

		if (used.has(id)) {
			throw new Error("Incident identifier source repeated an identity");
		}

		used.add(id);

		var title = prefix + id;

		if (options.store.read(title).kind !== "absent") {
			throw new Error("Incident title is already occupied");
		}

		var body = {
			version: 1,
			kind: "incident",
			platform: options.platform,
			incident: incident
		};

		options.store.apply(transitions.transition(title, null, {
			title: title,
			type: "application/json",
			"clerus-custody": "user",
			"clerus-wal-kind": "incident",
			text: JSON.stringify(body)
		}));

		return title;
	}

	return Object.freeze({
		record: record
	});
}

exports.create = create;