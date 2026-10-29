/*\
title: $:/plugins/clerus/core/lifecycle.js
type: application/javascript
module-type: library
\*/

"use strict";

var effects = require("$:/plugins/clerus/core/effects.js");

function describeError(error) {
	return {
		name: error && error.name ? String(error.name) : "Error",
		message: String(error && error.message || error),
		stack: error && error.stack ? String(error.stack) : null
	};
}

function dismissEphemeral(options) {
	var wiki = options.wiki;
	var job = options.job;
	var platform = options.platform;
	var prefix = "$:/temp/clerus/jobs/" + platform + "/";

	if (job.persistent || job.title.indexOf(prefix) !== 0) {
		throw new Error("Only local ephemeral jobs can be dismissed");
	}

	var current = wiki.getTiddler(job.title);

	if (!current) {
		throw new Error("Cannot dismiss a missing job");
	}

	if (current.fields["clerus-custody"] !== platform) {
		throw new Error("Cannot dismiss a job no longer owned locally");
	}

	if (current.fields["clerus-executor"] !== job.executor) {
		throw new Error("Cannot dismiss a job whose executor has changed");
	}

	if (current.fields.type !== "application/json") {
		throw new Error("Cannot dismiss a non-JSON job");
	}

	// Read the current registry: earlier ephemeral effects remain committed.
	var registry = JSON.parse(current.fields.text);

	if (
		registry === null ||
		typeof registry !== "object" ||
		Array.isArray(registry)
	) {
		throw new Error("Cannot dismiss a job with an invalid registry");
	}

	var charterKeys = Object.keys(registry).filter(function (key) {
		var document = registry[key];

		return document !== null &&
			typeof document === "object" &&
			!Array.isArray(document) &&
			document.form === "charter";
	});

	if (charterKeys.length !== 1) {
		throw new Error("Cannot dismiss a job without exactly one charter");
	}

	var charter = registry[charterKeys[0]];

	// The previous status may contain useful evidence.
	charter.status = {
		phase: "dismissed",
		previous: Object.prototype.hasOwnProperty.call(charter, "status")
			? charter.status
			: null,
		error: options.error
	};

	var effect = effects.put(
		current,
		new options.Tiddler(current, {
			"clerus-custody": "user",
			text: JSON.stringify(registry)
		})
	);

	effects.apply(wiki, options.Tiddler, effect);

	return registry;
}

exports.describeError = describeError;
exports.dismissEphemeral = dismissEphemeral;

function suspendPersistent(options) {
	var wiki = options.wiki;
	var job = options.job;
	var current = wiki.getTiddler(job.title);

	if (
		!job.persistent ||
		job.title.indexOf("$:/clerus/jobs/") !== 0 ||
		!current ||
		current.fields.type !== "application/json" ||
		current.fields["clerus-custody"] !== options.platform ||
		current.fields["clerus-executor"] !== job.executor
	) {
		throw new Error("Persistent job is no longer locally authorized");
	}

	var registry = JSON.parse(current.fields.text);
	var charterKeys = Object.keys(registry).filter(function (key) {
		var document = registry[key];

		return document !== null &&
			typeof document === "object" &&
			!Array.isArray(document) &&
			document.form === "charter";
	});

	if (charterKeys.length !== 1) {
		throw new Error("Suspension requires exactly one charter");
	}

	var charter = registry[charterKeys[0]];

	charter.status = {
		phase: "suspended",
		previous: Object.prototype.hasOwnProperty.call(charter, "status")
			? charter.status
			: null,
		error: options.error
	};

	effects.apply(
		wiki,
		options.Tiddler,
		effects.put(current, new options.Tiddler(current, {
			"clerus-custody": "user",
			"clerus-suspended": "yes",
			text: JSON.stringify(registry)
		}))
	);

	return registry;
}

function acknowledgeResumption(options) {
	var current = options.wiki.getTiddler(options.job.title);

	if (
		!current ||
		current.fields["clerus-custody"] !== options.platform ||
		current.fields["clerus-executor"] !== options.job.executor ||
		current.fields["clerus-suspended"] !== "yes"
	) {
		throw new Error("Cannot acknowledge persistent resumption");
	}

	effects.apply(
		options.wiki,
		options.Tiddler,
		effects.put(current, new options.Tiddler(current, {
			"clerus-suspended": undefined
		}))
	);
}

exports.suspendPersistent = suspendPersistent;
exports.acknowledgeResumption = acknowledgeResumption;