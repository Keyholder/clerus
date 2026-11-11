/*\
title: $:/plugins/clerus/core/observation.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var missionObservation = require(
	"$:/plugins/clerus/core/mission-observation.js"
);
var jobObservation = require(
	"$:/plugins/clerus/core/job-observation.js"
);
var observedJobs = require("$:/plugins/clerus/core/observed-job.js");

function assertTitles(titles) {
	if (
		!Array.isArray(titles) ||
		!titles.every(function (title) {
			return typeof title === "string" &&
				title.length > 0;
		})
	) {
		throw new Error("Observation requires an array of job titles");
	}

	if (new Set(titles).size !== titles.length) {
		throw new Error("Observation job titles must be unique");
	}
}

function signature(view) {
	if (
		!schemas.isRecord(view) ||
		(
			view.kind !== "absent" &&
			view.kind !== "materialized" &&
			view.kind !== "shadow"
		)
	) {
		throw new Error("Invalid observed tiddler view");
	}

	if (view.kind === "absent") {
		if (view.fields !== null) {
			throw new Error("Absent tiddler must have null fields");
		}

		return JSON.stringify(["absent"]);
	}

	if (!schemas.isRecord(view.fields)) {
		throw new Error("Observed tiddler fields must be a record");
	}

	var fields = Object.keys(view.fields).sort().map(function (key) {
		if (typeof view.fields[key] !== "string") {
			throw new Error("Observed field values must be strings");
		}

		return [key, view.fields[key]];
	});

	return JSON.stringify([view.kind, fields]);
}

function Observer() {
	this.previous = new Map();
	this.epoch = {};
	this.prepared = new WeakMap();
}

Observer.prototype.prepare = function (options) {
	schemas.assertPlatform(options.platform);
	assertTitles(options.titles);

	var store = options.store;

	if (!store || typeof store.read !== "function") {
		throw new Error("Observation requires a store");
	}

	var history = this.previous;
	var epoch = this.epoch;
	var next = new Map();
	var events = [];
	var targetSignatures = new Map();
	var jobs = null;

	function readJobs() {
		if (typeof options.readJobs !== "function") {
			throw new Error("Mission observation requires a job reader");
		}

		if (jobs === null) {
			jobs = options.readJobs();
		}

		return jobs;
	}

	/*
	Read one target once per collection pass, even if several
	jobs subscribe to it.
	*/
	function readSignature(title) {
		if (!targetSignatures.has(title)) {
			var view = store.read(title);

			if (
				view.kind !== "absent" &&
				(!view.fields || view.fields.title !== title)
			) {
				throw new Error("Observed tiddler identity mismatch");
			}

			targetSignatures.set(title, signature(view));
		}

		return targetSignatures.get(title);
	}

	options.titles.slice().sort().forEach(function (title) {
		var stored = store.read(title);

		if (stored.kind === "absent") {
			return;
		}

		if (stored.kind !== "materialized") {
			throw new Error(
				"Observed job must be materialized: " + title
			);
		}

		var job = observedJobs.read(
			stored.fields,
			options.platform
		);

		var subscriptions = new Map();

		Object.keys(job.registry).sort().forEach(function (key) {
			var document = job.registry[key];

			if (!schemas.isOrdinaryTitle(document)) {
				return;
			}

			if (!subscriptions.has(document)) {
				subscriptions.set(document, []);
			}

			subscriptions.get(document).push(key);
		});

		missionObservation.collect(job, {
			store: store,
			platform: options.platform,
			readJobs: readJobs
		}).forEach(function (subscription) {
			next.set(subscription.id, subscription.signature);

			if (
				history.has(subscription.id) &&
				history.get(subscription.id) !==
					subscription.signature
			) {
				events.push(subscription.event);
			}
		}, this);

		jobObservation.collect(job, {
			store: store,
			platform: options.platform
		}).forEach(function (subscription) {
			next.set(subscription.id, subscription.signature);

			if (
				history.has(subscription.id) &&
				history.get(subscription.id) !==
					subscription.signature
			) {
				events.push(subscription.event);
			}
		}, this);

		Array.from(subscriptions.keys()).sort().forEach(
			function (target) {
				var id = JSON.stringify([job.title, target]);
				var current = readSignature(target);
				var previous = history.get(id);

				next.set(id, current);

				if (
					history.has(id) &&
					previous !== current
				) {
					events.push(Object.freeze({
						type: "document-change",
						title: job.title,
						platform: options.platform,
						target: target,
						keys: Object.freeze(
							subscriptions.get(target).slice()
						)
					}));
				}
			},
			this
		);
	}, this);

	if (this.epoch !== epoch) {
		throw new Error("Observation history changed during preparation");
	}

	var batch = Object.freeze({
		events: Object.freeze(events)
	});

	this.prepared.set(batch, {
		epoch: epoch,
		next: next
	});

	return batch;
};

Observer.prototype.commit = function (batch) {
	var prepared = batch &&
		typeof batch === "object"
			? this.prepared.get(batch)
			: undefined;

	if (!prepared) {
		throw new Error("Unknown observation batch");
	}

	if (prepared.epoch !== this.epoch) {
		throw new Error("Observation batch is stale");
	}

	this.previous = prepared.next;
	this.epoch = {};
	this.prepared.delete(batch);
};

Observer.prototype.collect = function (options) {
	var batch = this.prepare(options);

	this.commit(batch);
	return batch.events;
};

Observer.prototype.clear = function () {
	this.previous = new Map();
	this.epoch = {};
};

function refresh(event, options) {
	if (event && event.type === "mission-change") {
		return missionObservation.refresh(event, options);
	}

	if (event && event.type === "job-status-change") {
		return jobObservation.refresh(event, options);
	}

	schemas.assertPlatform(options.platform);

	var source = schemas.copyJSON(event);

	if (
		!schemas.isRecord(source) ||
		source.type !== "document-change" ||
		typeof source.title !== "string" ||
		source.title.length === 0 ||
		source.platform !== options.platform ||
		!schemas.isOrdinaryTitle(source.target)
	) {
		throw new Error("Invalid observation event");
	}

	var store = options.store;

	if (!store || typeof store.read !== "function") {
		throw new Error("Observation delivery requires a store");
	}

	var stored = store.read(source.title);

	if (stored.kind === "absent") {
		return null;
	}

	if (stored.kind !== "materialized") {
		throw new Error(
			"Observed recipient must be materialized"
		);
	}

	var job = observedJobs.read(
		stored.fields,
		options.platform
	);

	var keys = Object.keys(job.registry).filter(function (key) {
		return job.registry[key] === source.target;
	}).sort();

	if (keys.length === 0) {
		return null;
	}

	return Object.freeze({
		type: "document-change",
		title: job.title,
		platform: options.platform,
		target: source.target,
		keys: Object.freeze(keys)
	});
}

exports.Observer = Observer;
exports.refresh = refresh;