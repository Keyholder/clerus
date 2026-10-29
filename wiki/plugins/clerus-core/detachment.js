/*\
title: $:/plugins/clerus/core/detachment.js
type: application/javascript
module-type: library
\*/

"use strict";

var missions = require("$:/plugins/clerus/core/missions.js");

function resign(options) {
	var runtime = options.runtime;
	var source = options.job;
	var documents = options.documents || [options.document];

	if (source.persistent) {
		throw new Error("Persistent resignation requires a work plan");
	}

	if (!documents.every(missions.isMission)) {
		throw new Error("Every detached document must be a valid mission");
	}

	var current = runtime.inspect().jobs.find(function (job) {
		return job.title === source.title;
	});

	if (
		!current ||
		!current.valid ||
		!current.local ||
		!current.owned ||
		current.executor !== source.executor
	) {
		throw new Error("Source job is no longer eligible");
	}

	if (
		!options.documents &&
		JSON.stringify(current.registry[options.key]) !==
			JSON.stringify(options.document)
	) {
		throw new Error("Mission has changed outside this context");
	}

	documents.forEach(function (document) {
		var held = Object.keys(current.registry).some(function (key) {
			return JSON.stringify(current.registry[key]) ===
				JSON.stringify(document);
		});

		if (!held) {
			throw new Error("Selected mission is no longer held");
		}
	});

	var sourceKeys = Object.keys(current.registry).filter(function (key) {
		return documents.some(function (document) {
			return missions.sameIdentity(
				current.registry[key],
				document
			);
		});
	});

	var identities = new Map();

	sourceKeys.forEach(function (key) {
		var document = current.registry[key];
		var identity = JSON.stringify([
			document.project,
			document.role,
			document.link
		]);

		identities.set(identity, {
			project: document.project,
			role: document.role.slice(),
			link: document.link
		});
	});

	// Only the source registry is changed. Descendant authority is derived.
	sourceKeys.forEach(function (key) {
		options.replace(key, undefined);
	});

	return {
		sourceKeys: sourceKeys,
		affected: sourceKeys.length === 0
			? []
			: [{
				title: current.title,
				executor: current.executor,
				keys: sourceKeys.slice(),
				roles: Array.from(identities.values())
			}]
	};
}

exports.resign = resign;