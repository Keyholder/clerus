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
var persistentReactions = require(
	"$:/plugins/clerus/core2/persistent-reaction.js"
);
var flowObligations = require(
	"$:/plugins/clerus/core2/flow-obligations.js"
);
var FlowScheduler = require(
	"$:/plugins/clerus/core2/flow-scheduler.js"
).Scheduler;

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
	this.resolveExecutor = options.resolveExecutor;
	this.newId = options.newId;
	this.executing = false;

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

	this.flows = flowObligations.create({
		store: this.store,
		platform: this.platform,
		newId: this.newId
	});

	this.flowScheduler = new FlowScheduler({
		store: this.store,
		platform: this.platform,
		newId: this.newId,
		resolveExecutor: this.resolveExecutor,

		onResult: function (context) {
			this.handlePersistentResult(
				context.title,
				context.executor,
				context.handler,
				context.event,
				context.result
			);
		}.bind(this)
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

Runtime.prototype.handlePersistentResult = function (
	title,
	executor,
	handler,
	event,
	result
) {
	if (
		result.status !== "failed" ||
		result.phase !== "reaction"
	) {
		return;
	}

	var current = this.store.read(title);

	if (
		current.kind === "materialized" &&
		current.fields["clerus-executor"] === executor &&
		current.fields["clerus-custody"] === "user"
	) {
		return;
	}

	result.lifecycle = this.lifecycle.suspend({
		title: title,
		executor: executor,
		event: event,
		error: result.error
	});

	if (!result.lifecycle.suspended) {
		return;
	}

	var notification = persistentReactions.execute({
		store: this.store,
		title: title,
		platform: this.platform,
		event: { type: "suspended" },
		handler: handler,
		newId: this.newId
	});

	result.notification = {
		status: notification.status === "failed"
			? "ignored-error"
			: notification.status
	};

	/*
		A restricted notification may legally send messages
		without changing its own operational registry.
	*/
	if (
		notification.status === "completed" &&
		notification.pending.length > 0
	) {
		this.flowScheduler.track(notification.obligation);
	}
};

Runtime.prototype.dispatch = function (title, event, incoming) {
	if (this.executing || this.scheduler.running || this.flowScheduler.running) {
		throw new Error("Cannot start a nested runtime dispatch");
	}

	var space = jobTitles.classify(title);

	if (!space) {
		throw new Error("Dispatch requires a job title");
	}

	this.executing = true;

	try {
		if (!space.persistent) {
			return this.scheduler.dispatch(
				title,
				event,
				incoming
			);
		}

		var stored = this.store.read(title);

		if (stored.kind !== "materialized") {
			return {
				status: "unavailable",
				reason: "job-not-materialized"
			};
		}

		if (
			stored.fields.type !== "application/json" ||
			typeof stored.fields["clerus-executor"] !== "string" ||
			stored.fields["clerus-executor"].length === 0
		) {
			return {
				status: "unavailable",
				reason: "invalid-job-header"
			};
		}

		var handler = this.resolveExecutor(
			stored.fields["clerus-executor"]
		);

		if (typeof handler !== "function") {
			return {
				status: "unavailable",
				reason: "executor-unavailable"
			};
		}

		var resumptionPending =
			stored.fields["clerus-suspended"] === "yes" &&
			stored.fields["clerus-custody"] === this.platform;

		var resumedEvent =
			schemas.isRecord(event) &&
			event.type === "resumed";

		if (resumptionPending && !resumedEvent) {
			return {
				status: "blocked",
				reason: "resumption-required",
				obligations: []
			};
		}

		if (resumedEvent && !resumptionPending) {
			return {
				status: "unavailable",
				reason: "resumption-not-pending"
			};
		}

		if (resumedEvent && incoming !== undefined) {
			return {
				status: "unavailable",
				reason: "resumption-cannot-carry-incoming-documents"
			};
		}
		
		var executor = stored.fields["clerus-executor"];

		var result = persistentReactions.execute({
			store: this.store,
			title: title,
			platform: this.platform,
			event: event,
			incoming: incoming,
			handler: handler,
			newId: this.newId,
			acknowledgeResumption: resumptionPending && resumedEvent
		});

		this.handlePersistentResult(
			title,
			executor,
			handler,
			event,
			result
		);

		if (result.obligation) {
			var journal = this.store.read(result.obligation);

			if (
				journal.kind === "materialized" &&
				journal.fields["clerus-wal-kind"] === "flow"
			) {
				this.flowScheduler.track(result.obligation);
			}
		}

		result.flow = this.flowScheduler.drain();

		return result;
	} finally {
		this.executing = false;
	}
};

Runtime.prototype.observe = function () {
	if (this.executing || this.scheduler.running || this.flowScheduler.running) {
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

Runtime.prototype.drainFlows = function () {
	if (
		this.executing ||
		this.scheduler.running ||
		this.flowScheduler.running
	) {
		throw new Error("Cannot start a nested flow pass");
	}

	this.executing = true;

	try {
		return this.flowScheduler.drain();
	} finally {
		this.executing = false;
	}
};

Runtime.prototype.recover = function () {
	if (
		this.executing ||
		this.scheduler.running ||
		this.flowScheduler.running
	) {
		throw new Error("Cannot recover obligations during a reaction");
	}

	this.executing = true;

	try {
		var ordinary = this.obligations.recover();
		var flow = this.flows.recover();

		flow.entries.forEach(function (entry) {
			if (entry.status === "pending") {
				this.flowScheduler.track(entry.title);
			}
		}, this);

		return {
			entries: ordinary.entries.filter(function (entry) {
				return entry.status !== "delegated";
			}).concat(flow.entries),

			pendingFlowAttempts: this.flowScheduler.queue.size
		};
	} finally {
		this.executing = false;
	}
};

Runtime.prototype.resume = function (title) {
	var space = jobTitles.classify(title);

	if (!space || !space.persistent) {
		throw new Error("Resumption requires a persistent job");
	}

	return this.dispatch(title, {
		type: "resumed"
	});
};

exports.Runtime = Runtime;