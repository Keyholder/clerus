/*\
title: $:/plugins/clerus/core2/runtime.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");
var Store = require("$:/plugins/clerus/core2/store.js").Store;
var Scheduler = require("$:/plugins/clerus/core2/scheduler.js").Scheduler;
var observation = require("$:/plugins/clerus/core2/observation.js");
var incidents = require("$:/plugins/clerus/core2/incidents.js");
var lifecycle = require("$:/plugins/clerus/core2/lifecycle.js");
var hierarchy = require("$:/plugins/clerus/core2/hierarchy.js");
var missions = require("$:/plugins/clerus/core2/missions.js");
var obligations = require(
	"$:/plugins/clerus/core2/obligations.js"
);

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
);

function Runtime(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.wiki ||
		typeof options.wiki.each !== "function" ||
		typeof options.Tiddler !== "function" ||
		typeof options.resolveExecutor !== "function" ||
		typeof options.newId !== "function"
	) {
		throw new Error(
			"Runtime requires a wiki, Tiddler, executor resolver and identity source"
		);
	}

	this.wiki = options.wiki;
	this.platform = options.platform;

	this.store = new Store({
		wiki: options.wiki,
		Tiddler: options.Tiddler
	});

	this.obligations = obligations.create({
		store: this.store,
		platform: this.platform,
		newId: options.newId
	});

	this.readJobs = this.readJobs.bind(this);

	this.incidents = incidents.create({
		store: this.store,
		platform: this.platform,
		newId: options.newId
	});

	this.lifecycle = lifecycle.create({
		store: this.store,
		platform: this.platform,
		recordIncident: this.incidents.record
	});

	this.observer = new observation.Observer();

	this.scheduler = new Scheduler({
		store: this.store,
		platform: this.platform,
		readJobs: this.readJobs,
		resolveExecutor: options.resolveExecutor,
		newId: options.newId,
		lifecycle: this.lifecycle
	});
}

Runtime.prototype.readJobs = function () {
	var jobs = [];

	this.wiki.each(function (tiddler, title) {
		if (!jobTitles.isJobTitle(title)) {
			return;
		}

		var registry = null;

		if (tiddler.fields.type === "application/json") {
			try {
				var parsed = JSON.parse(tiddler.fields.text);

				if (schemas.isRecord(parsed)) {
					registry = parsed;
				}
			} catch (error) {
				// Preserve the uninspectable job in the projection.
			}
		}

		jobs.push({
			title: title,

			custody: hasOwn(tiddler.fields, "clerus-custody")
				? tiddler.fields["clerus-custody"]
				: "user",

			executor: tiddler.fields["clerus-executor"] === undefined
				? null
				: tiddler.fields["clerus-executor"],

			registry: registry
		});
	});

	jobs.sort(function (left, right) {
		return left.title < right.title
			? -1
			: left.title > right.title ? 1 : 0;
	});

	return schemas.copyJSON(jobs);
};

Runtime.prototype.dispatch = function (title, event, incoming) {
	return this.scheduler.dispatch(title, event, incoming);
};

Runtime.prototype.observe = function () {
	if (this.scheduler.running) {
		throw new Error("Cannot collect observations during a reaction");
	}

	var titles = this.readJobs().filter(function (job) {
		var space = jobTitles.classify(job.title);

		return !space.persistent &&
			space.platform === this.platform;
	}, this).map(function (job) {
		return job.title;
	});

	var events = this.observer.collect({
		store: this.store,
		platform: this.platform,
		titles: titles
	});

	var passes = [];

	events.forEach(function (event) {
		var current = observation.refresh(event, {
			store: this.store,
			platform: this.platform
		});

		if (!current) {
			return;
		}

		passes.push(this.scheduler.dispatch(
			current.title,
			current
		));
	}, this);

	return passes;
};

Runtime.prototype.resetObservation = function () {
	this.observer.clear();
};

Runtime.prototype.inspect = function () {
	var jobs = this.readJobs();

	return {
		platform: this.platform,
		jobs: jobs,
		hierarchy: hierarchy.evaluate(jobs),
		missions: missions.evaluate(jobs)
	};
};

Runtime.prototype.recover = function () {
	if (this.scheduler.running) {
		throw new Error("Cannot recover obligations during a reaction");
	}

	return this.obligations.recover();
};

exports.Runtime = Runtime;