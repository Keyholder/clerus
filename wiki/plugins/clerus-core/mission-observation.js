/*\
title: $:/plugins/clerus/core/mission-observation.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var missionSchema = require("$:/plugins/clerus/core/mission-schema.js");
var perspectives = require(
	"$:/plugins/clerus/core/project-perspective.js"
);
var signatures = require(
	"$:/plugins/clerus/core/observation-signature.js"
);

function event(title, platform, document, keys) {
	return Object.freeze({
		type: "mission-change",
		title: title,
		platform: platform,
		project: document.project,
		role: Object.freeze(document.role.slice()),
		link: document.link,
		keys: Object.freeze(keys.slice().sort())
	});
}

/*
Return subscriptions and their current signatures.
The caller owns publication of observation history.
*/
function collect(job, options) {
	var groups = new Map();

	Object.keys(job.registry).sort().forEach(function (key) {
		var value = job.registry[key];

		if (!schemas.isRecord(value) || value.form !== "mission") {
			return;
		}

		var document = missionSchema.validate(value);
		var identity = missionSchema.identity(document);

		if (!groups.has(identity)) {
			groups.set(identity, {
				document: document,
				keys: []
			});
		}

		groups.get(identity).keys.push(key);
	});

	if (groups.size === 0) {
		return [];
	}

	var perspective = perspectives.create({
		title: job.title,
		platform: options.platform,
		store: options.store,
		readJobs: options.readJobs
	});

	var scope = {
		operational: job.registry,
		incoming: null,
		outgoing: []
	};

	var result = [];

	groups.forEach(function (group, identity) {
		var view = perspective.readMission(group.document, scope);

		result.push({
			id: JSON.stringify(["mission", job.title, identity]),
			signature: signatures.signature(view),
			event: event(
				job.title,
				options.platform,
				group.document,
				group.keys
			)
		});
	});

	return result;
}

function refresh(value, options) {
	schemas.assertPlatform(options.platform);

	var source = schemas.copyJSON(value);

	if (
		!schemas.isRecord(source) ||
		source.type !== "mission-change" ||
		typeof source.title !== "string" ||
		source.title.length === 0 ||
		source.platform !== options.platform
	) {
		throw new Error("Invalid mission observation event");
	}

	/*
	Validate the address using the same schema as actual
	assignments. issued and children are irrelevant to identity.
	*/
	var address = missionSchema.validate({
		form: "mission",
		project: source.project,
		role: source.role,
		link: source.link,
		issued: "0",
		children: {}
	});

	var identity = missionSchema.identity(address);
	var stored = options.store.read(source.title);

	if (stored.kind === "absent") {
		return null;
	}

	if (stored.kind !== "materialized") {
		throw new Error("Observed mission recipient must be materialized");
	}

	var job = schemas.ephemeralJob(
		stored.fields,
		options.platform
	);

	var keys = Object.keys(job.registry).filter(function (key) {
		var document = job.registry[key];

		return schemas.isRecord(document) &&
			document.form === "mission" &&
			missionSchema.identity(document) === identity;
	}).sort();

	if (keys.length === 0) {
		return null;
	}

	/*
	Do not authorize from the collected signature.
	The handler will inspect its current instrument.
	*/
	return event(
		source.title,
		options.platform,
		address,
		keys
	);
}

exports.collect = collect;
exports.refresh = refresh;