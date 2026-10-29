/*\
title: $:/plugins/clerus/core/runtime.js
type: application/javascript
module-type: library
\*/

"use strict";

var hierarchy = require("$:/plugins/clerus/core/hierarchy.js");
var missions = require("$:/plugins/clerus/core/missions.js");

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
	for (var i = 0; i < SPACES.length; i++) {
		var space = SPACES[i];

		if (title.indexOf(space.prefix) === 0) {
			return space;
		}
	}

	return null;
}

function isRecord(value) {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value);
}

function isDocument(value) {
	// This only checks the serialization envelope.
	// Form-specific validation belongs to document modules.
	return typeof value === "string" || isRecord(value);
}

function projectJob(tiddler, space, platform) {
	var fields = tiddler.fields;
	var errors = [];
	var custody = fields["clerus-custody"] || "user";
	var executor = fields["clerus-executor"];
	var registry = null;

	if (
		custody !== "user" &&
		custody !== "browser" &&
		custody !== "node"
	) {
		errors.push("Invalid clerus-custody");
	}

	// User custody is allowed for suspended/dismissed jobs.
	if (
		!space.persistent &&
		custody !== "user" &&
		custody !== space.platform
	) {
		errors.push("Custody does not match temporary title space");
	}

	if (typeof executor !== "string" || executor.length === 0) {
		errors.push("Missing clerus-executor");
	}

	if (fields.type !== "application/json") {
		errors.push("Job must have type application/json");
	}

	try {
		registry = JSON.parse(fields.text);
	} catch (error) {
		errors.push("Invalid registry JSON: " + error.message);
	}

	if (registry !== null) {
		if (!isRecord(registry)) {
			errors.push("Registry must be a JSON object");
			registry = null;
		} else {
			var charterCount = 0;

			Object.keys(registry).forEach(function (key) {
				var document = registry[key];

				if (!isDocument(document)) {
					errors.push("Invalid document at key: " + key);
				}

				if (isRecord(document) && document.form === "charter") {
					charterCount++;

					if (
						!Object.prototype.hasOwnProperty.call(
							document, "status"
						)
					) {
						errors.push("Charter must contain status");
					}
				}

				if (
					document &&
					typeof document === "object" &&
					document.form === "mission" &&
					!missions.isMission(document)
				) {
					errors.push("Invalid mission at key: " + key);
				}
			});

			if (charterCount !== 1) {
				errors.push("Registry must contain exactly one charter");
			}
		}
	}

	return {
		title: fields.title,
		persistent: space.persistent,
		custody: custody,
		executor: executor || null,
		local: space.persistent || space.platform === platform,
		owned: custody === platform,
		valid: errors.length === 0,
		errors: errors,
		registry: registry
	};
}

function Runtime(options) {
	this.wiki = options.wiki;
	this.platform = options.platform;
	this.jobs = new Map();
	this.started = false;
	this.onChange = this.onChange.bind(this);
}

Runtime.prototype.refresh = function (title) {
	var space = classify(title);

	if (!space) {
		return;
	}

	var tiddler = this.wiki.getTiddler(title);

	if (!tiddler) {
		this.jobs.delete(title);
		return;
	}

	this.jobs.set(
		title,
		projectJob(tiddler, space, this.platform)
	);
};

Runtime.prototype.onChange = function (changes) {
	Object.keys(changes).forEach(this.refresh, this);
};

Runtime.prototype.start = function () {
	if (this.started) {
		return;
	}

	this.started = true;
	this.jobs.clear();

	this.wiki.addEventListener("change", this.onChange);

	this.wiki.each(function (tiddler, title) {
		this.refresh(title);
	}.bind(this));
};

Runtime.prototype.stop = function () {
	if (!this.started) {
		return;
	}

	this.wiki.removeEventListener("change", this.onChange);
	this.jobs.clear();
	this.started = false;
};

Runtime.prototype.inspect = function () {
	// Explicit refresh makes inspection independent of change-event batching.
	this.jobs.clear();

	this.wiki.each(function (tiddler, title) {
		this.refresh(title);
	}.bind(this));

	var jobs = Array.from(this.jobs.values());

	jobs.sort(function (a, b) {
		return a.title < b.title ? -1 : a.title > b.title ? 1 : 0;
	});

	/*
	Load here rather than during module initialization:
	retention interprets appointment effects, whose materializer
	depends on Runtime.
	*/
	var retention =
		require("$:/plugins/clerus/core/job-retention.js");

	// Inspection never exposes references to the internal projection.
	return JSON.parse(JSON.stringify({
		platform: this.platform,
		started: this.started,
		jobs: jobs,
		missions: missions.audit(jobs),
		hierarchy: hierarchy.audit(jobs),
		retention: retention.evaluate(this.wiki, jobs)
	}));
};

exports.Runtime = Runtime;