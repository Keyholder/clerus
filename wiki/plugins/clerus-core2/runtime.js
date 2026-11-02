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
var ephemeralReactions = require(
	"$:/plugins/clerus/core2/reaction.js"
);
var MaterializationError = require(
	"$:/plugins/clerus/core2/operation.js"
).MaterializationError;
var deferredActivations = require(
	"$:/plugins/clerus/core2/deferred.js"
);
var deferredObligations = require(
	"$:/plugins/clerus/core2/deferred-obligations.js"
);
var retention = require("$:/plugins/clerus/core2/retention.js");

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

	this.runningDeferred = false;

	this.deferred = deferredActivations.create({
		store: this.store,
		platform: this.platform,
		newId: this.newId
	});

	this.persistentDeferred = deferredObligations.create({
		store: this.store,
		platform: this.platform
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
		lifecycle: this.lifecycle,

		executePersistent: function (context) {
			return this.executePersistentIngress(context);
		}.bind(this),

		checkDeferred: this.deferred.check,
		acceptDeferred: this.deferred.request
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

		executeEphemeral: function (context) {
			return this.executeEphemeralDelivery(context);
		}.bind(this),

		onResult: function (context) {
			this.handleFlowResult(context);
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

Runtime.prototype.executePersistentIngress = function (context) {
	var stored = this.store.read(context.title);

	if (
		stored.kind !== "materialized" ||
		stored.fields["clerus-executor"] !== context.executor
	) {
		return {
			status: "unavailable",
			reason: "ingress-recipient-changed"
		};
	}

	if (
		stored.fields["clerus-suspended"] === "yes" &&
		stored.fields["clerus-custody"] === this.platform
	) {
		return {
			status: "blocked",
			reason: "resumption-required",
			obligations: []
		};
	}

	/*
		No options.flow: this incoming event is not yet part of
		a durable transactional flow.
	*/
	var result = persistentReactions.execute({
		store: this.store,
		title: context.title,
		platform: this.platform,
		event: context.event,
		incoming: context.incoming,
		handler: context.handler,
		newId: this.newId
	});

	this.handlePersistentResult(
		context.title,
		context.executor,
		context.handler,
		context.event,
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

	return result;
};

Runtime.prototype.executeEphemeralDelivery = function (context) {
	var message = context.message;
	var invoked = false;

	var event = {
		type: message.type,
		id: message.id
	};

	if (message.type === "report") {
		event.project = message.project;
		event.role = message.role.slice();
	}

	var execution = {
		store: this.store,
		title: message.recipient.title,
		platform: this.platform,
		event: event,
		incoming: message.registry,
		readJobs: this.readJobs,
		newId: this.newId,
		checkMessage: this.scheduler.checkMessage,
		acceptMessage: this.scheduler.acceptMessage,
		requireSentOutgoing: true,
		checkDeferred: this.deferred.check,
		acceptDeferred: this.deferred.request
	};

	var wrappedHandler = function (event, operational, incoming) {
		invoked = true;

		return context.handler(
			event,
			operational,
			incoming
		);
	};

	try {
		if (message.establishing === true) {
			execution.resolveExecutor = function (name) {
				if (name !== message.recipient.executor) {
					throw new Error(
						"Establishment executor does not match the message"
					);
				}

				return wrappedHandler;
			};

			ephemeralReactions.establish(execution);
		} else {
			execution.handler = wrappedHandler;
			ephemeralReactions.execute(execution);
		}

		return {
			status: "completed"
		};
	} catch (error) {
		return {
			status: "failed",

			phase: error instanceof MaterializationError
				? "materialization"
				: invoked ? "reaction" : "preparation",

			error: lifecycle.describeError(error)
		};
	}
};

Runtime.prototype.handleFlowResult = function (context) {
	var space = jobTitles.classify(context.title);

	if (space.persistent) {
		this.handlePersistentResult(
			context.title,
			context.executor,
			context.handler,
			context.event,
			context.result
		);

		return;
	}

	if (
		context.result.status !== "failed" ||
		context.result.phase !== "reaction"
	) {
		return;
	}

	var policy = { errors: [] };

	this.scheduler.handleFailure({
		title: context.title,
		executor: context.executor,
		event: context.event
	}, context.result.error, policy);

	if (policy.errors.length > 0) {
		var diagnostic = policy.errors[0];

		if (diagnostic.lifecycle) {
			context.result.lifecycle = diagnostic.lifecycle;
		}

		if (diagnostic.lifecycleError) {
			context.result.lifecycleError =
				diagnostic.lifecycleError;
		}
	}
};

Runtime.prototype.drainOfficialWork = function () {
	var result = {
		completed: [],
		blocked: [],
		unavailable: [],
		errors: [],
		ephemeral: [],
		remaining: 0,
		ephemeralRemaining: 0
	};

	while (true) {
		if (this.scheduler.queue.length > 0) {
			result.ephemeral.push(this.scheduler.drain());
		}

		var existing = new Set(this.scheduler.queue);
		var flow = this.flowScheduler.drain();

		[
			"completed",
			"blocked",
			"unavailable",
			"errors"
		].forEach(function (name) {
			result[name] = result[name].concat(flow[name]);
		});

		/*
			Continue only if flow delivery accepted new ephemeral
			work. Merely unavailable old work must not cause a spin.
		*/
		var added = this.scheduler.queue.some(function (work) {
			return !existing.has(work);
		});

		if (!added) {
			break;
		}
	}

	result.remaining = this.flowScheduler.queue.size;
	result.ephemeralRemaining = this.scheduler.queue.length;

	return result;
};

Runtime.prototype.dispatchDeferred = function (title) {
	if (
		this.executing ||
		this.scheduler.running ||
		this.flowScheduler.running
	) {
		throw new Error("Cannot start a nested deferred delivery");
	}

	this.executing = true;

	try {
		var loaded = this.persistentDeferred.read(title);
		var effect = loaded.effect;

		var owner = this.store.read(effect.recipient.title);

		if (
			owner.kind !== "materialized" ||
			owner.fields["clerus-executor"] !==
				effect.recipient.executor
		) {
			return {
				status: "unavailable",
				reason: "deferred-recipient-changed"
			};
		}

		if (
			owner.fields["clerus-suspended"] === "yes" &&
			owner.fields["clerus-custody"] === this.platform
		) {
			return {
				status: "blocked",
				reason: "resumption-required",
				obligations: []
			};
		}

		var handler = this.resolveExecutor(
			effect.recipient.executor
		);

		if (typeof handler !== "function") {
			return {
				status: "unavailable",
				reason: "executor-unavailable"
			};
		}

		var event = {
			type: "tick",
			id: effect.id
		};

		var result = persistentReactions.execute({
			store: this.store,
			title: effect.recipient.title,
			platform: this.platform,
			handler: handler,
			newId: this.newId,

			deferred: {
				title: title,
				id: effect.id
			}
		});

		this.handlePersistentResult(
			effect.recipient.title,
			effect.recipient.executor,
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

		result.flow = this.drainOfficialWork();

		return result;
	} finally {
		this.executing = false;
	}
};

Runtime.prototype.runDeferred = function () {
	if (
		this.executing ||
		this.scheduler.running ||
		this.flowScheduler.running ||
		this.runningDeferred
	) {
		throw new Error("Cannot start a nested deferred pass");
	}

	var prefix = "$:/clerus/wal/" + this.platform + "/";

	/*
		Capture before running any tick, including ephemeral ones.
	*/
	var persistentBatch = this.store.snapshot().materialized.filter(
		function (fields) {
			return fields.title.indexOf(prefix) === 0 &&
				fields["clerus-wal-kind"] === "deferred" &&
				fields["clerus-custody"] === this.platform;
		},
		this
	).map(function (fields) {
		return fields.title;
	}).sort();

	this.runningDeferred = true;

	try {
		var report = this.deferred.drain(function (title, event) {
			return this.dispatch(title, event);
		}.bind(this));

		report.persistent = [];

		persistentBatch.forEach(function (title) {
			var current = this.store.read(title);

			/*
				An earlier reaction may have resolved or paused it.
			*/
			if (
				current.kind !== "materialized" ||
				current.fields["clerus-wal-kind"] !== "deferred" ||
				current.fields["clerus-custody"] !== this.platform
			) {
				return;
			}

			try {
				report.persistent.push({
					title: title,
					result: this.dispatchDeferred(title)
				});
			} catch (error) {
				report.errors.push({
					title: title,
					phase: "persistent-deferred-delivery",
					error: lifecycle.describeError(error)
				});
			}
		}, this);

		report.persistentRemaining =
			this.store.snapshot().materialized.filter(function (fields) {
				return fields.title.indexOf(prefix) === 0 &&
					fields["clerus-wal-kind"] === "deferred" &&
					fields["clerus-custody"] === this.platform;
			}, this).length;

		return report;
	} finally {
		this.runningDeferred = false;
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
			var ephemeralResult = this.scheduler.dispatch(
				title,
				event,
				incoming
			);

			ephemeralResult.flow = this.drainOfficialWork();

			return ephemeralResult;
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

		result.flow = this.drainOfficialWork();

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

		passes.push(this.dispatch(current.title, current));
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
		missions: missions.evaluate(jobs),
		retention: retention.evaluate({
			jobs: jobs,
			tiddlers: this.store.snapshot().materialized
		})
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
		return this.drainOfficialWork();
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
				return !(
					entry.status === "delegated" &&
					entry.kind === "flow"
				);
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