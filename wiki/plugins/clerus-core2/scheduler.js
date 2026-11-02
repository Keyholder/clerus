/*\
title: $:/plugins/clerus/core/scheduler.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var reactions = require("$:/plugins/clerus/core/reaction.js");
var roles = require("$:/plugins/clerus/core/roles.js");
var MaterializationError = require(
	"$:/plugins/clerus/core/operation.js"
).MaterializationError;

function describe(error) {
	return {
		name: String(error && error.name || "Error"),
		message: String(error && error.message || error),
		stack: error && error.stack ? String(error.stack) : null
	};
}

function Scheduler(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.store.read !== "function" ||
		typeof options.store.apply !== "function" ||
		typeof options.readJobs !== "function" ||
		typeof options.resolveExecutor !== "function"
	) {
		throw new Error("Scheduler requires state and executor services");
	}

	if (
		options.newId !== undefined &&
		typeof options.newId !== "function"
	) {
		throw new Error("newId must be a function");
	}

	if (
		options.lifecycle !== undefined &&
		(
			!options.lifecycle ||
			typeof options.lifecycle.dismiss !== "function"
		)
	) {
		throw new Error("lifecycle must provide dismiss()");
	}

	if (
		options.executePersistent !== undefined &&
		typeof options.executePersistent !== "function"
	) {
		throw new Error("executePersistent must be a function");
	}

	this.options = options;
	this.queue = [];
	this.running = false;

	this.checkMessage = this.checkMessage.bind(this);
	this.acceptMessage = this.acceptMessage.bind(this);

	this.pendingBirths = new Set();
}

Scheduler.prototype.recipient = function (title, allowPersistent) {
	var space = jobTitles.classify(title);

	if (
		!space ||
		(!space.persistent && space.platform !== this.options.platform)
	) {
		throw new Error("Recipient is not local to this scheduler");
	}

	if (space.persistent && allowPersistent !== true) {
		throw new Error(
			"Initial dispatch requires a local ephemeral recipient"
		);
	}

	var stored = this.options.store.read(title);

	if (stored.kind !== "materialized") {
		throw new Error("Recipient is not materialized");
	}

	var job;

	if (space.persistent) {
		if (
			stored.fields.type !== "application/json" ||
			typeof stored.fields["clerus-executor"] !== "string" ||
			stored.fields["clerus-executor"].length === 0
		) {
			throw new Error("Invalid persistent recipient");
		}

		job = {
			title: title,
			executor: stored.fields["clerus-executor"],
			custody: stored.fields["clerus-custody"],
			registry: schemas.registry(
				JSON.parse(stored.fields.text),
				"operational"
			)
		};
	} else {
		job = schemas.ephemeralJob(
			stored.fields,
			this.options.platform
		);
	}

	var handler = this.options.resolveExecutor(job.executor);

	if (typeof handler !== "function") {
		throw new Error("Recipient executor is unavailable");
	}

	return {
		job: job,
		handler: handler,
		persistent: space.persistent
	};
};

Scheduler.prototype.prepareMessage = function (value) {
	var message = schemas.copyJSON(value);

	if (
		!schemas.isRecord(message) ||
		(message.type !== "order" && message.type !== "report") ||
		message.platform !== this.options.platform ||
		!jobTitles.isJobTitle(message.source) ||
		!jobTitles.isJobTitle(message.recipient) ||
		message.source === message.recipient
	) {
		throw new Error("Unsupported queued message");
	}

	message.registry = schemas.registry(
		message.registry,
		"incoming"
	);

	var event = { type: message.type };

	if (message.type === "report") {
		if (
			typeof message.project !== "string" ||
			message.project.length === 0 ||
			!roles.isRole(message.role) ||
			message.role.length === 0
		) {
			throw new Error("Queued report requires a role signature");
		}

		event.project = message.project;
		event.role = message.role.slice();
	}

	if (message.establishing === true) {
		var space = jobTitles.classify(message.recipient);

		if (
			message.type !== "order" ||
			space.persistent ||
			space.platform !== this.options.platform
		) {
			throw new Error(
				"This scheduler supports only local ephemeral establishment"
			);
		}

		if (
			this.options.store.read(message.recipient).kind !==
			"absent"
		) {
			throw new Error("Establishment target must be absent");
		}

		if (this.pendingBirths.has(message.recipient)) {
			throw new Error("Recipient already has a pending establishment");
		}

		var contracts = Object.keys(message.registry).filter(
			function (key) {
				return schemas.formOf(message.registry[key]) === "contract";
			}
		);

		if (contracts.length !== 1) {
			throw new Error(
				"Establishing order requires exactly one contract"
			);
		}

		var contract = message.registry[contracts[0]];

		if (
			contract.temp === false ||
			message.executor !== contract.executor
		) {
			throw new Error("Invalid establishment executor or durability");
		}

		if (
			typeof this.options.resolveExecutor(contract.executor) !==
			"function"
		) {
			throw new Error("Establishment executor is unavailable");
		}

		return {
			title: message.recipient,
			executor: contract.executor,
			event: event,
			incoming: message.registry,
			establishing: true
		};
	}

	if (message.establishing !== undefined) {
		throw new Error("Invalid establishment marker");
	}

	var recipient = this.recipient(message.recipient, true);

	if (
		jobTitles.classify(message.recipient).persistent &&
		(
			typeof this.options.executePersistent !== "function" ||
			typeof this.options.newId !== "function"
		)
	) {
		throw new Error("Persistent ingress is unavailable");
	}

	return {
		title: recipient.job.title,
		executor: recipient.job.executor,
		event: event,
		incoming: message.registry
	};
};

Scheduler.prototype.checkMessage = function (message) {
	this.prepareMessage(message);
};

Scheduler.prototype.acceptMessage = function (message) {
	var work = this.prepareMessage(message);
	var space = jobTitles.classify(work.title);

	if (space.persistent) {
		var id = this.options.newId();

		if (
			typeof id !== "string" ||
			!/^[A-Za-z0-9_-]{16,128}$/.test(id)
		) {
			throw new Error("Invalid ingress event identifier");
		}

		work.event.id = id;
	}

	if (work.establishing) {
		this.pendingBirths.add(work.title);
	}

	this.queue.push(work);
};

Scheduler.prototype.dispatch = function (title, event, incoming) {
	if (this.running) {
		throw new Error("Cannot start a nested dispatch pass");
	}

	var recipient = this.recipient(title);

	var initial = {
		title: title,
		executor: recipient.job.executor,
		event: schemas.copyJSON(event),
		incoming: incoming === undefined
			? undefined
			: schemas.registry(incoming, "incoming")
	};

	if (
		!schemas.isRecord(initial.event) ||
		typeof initial.event.type !== "string" ||
		initial.event.type.length === 0
	) {
		throw new Error("Dispatch requires an event type");
	}

	this.queue.push(initial);

	return this.drain();
};

Scheduler.prototype.handleFailure = function (work, error, result) {
	if (work.ignoreErrors) {
		return;
	}

	var lifecycle = this.options.lifecycle;
	var infrastructure = error instanceof MaterializationError;

	/*
		With lifecycle enabled, subsequent executor errors of a job
		already under user custody are ignored. Infrastructure
		failures remain visible.
	*/
	if (lifecycle && !infrastructure) {
		var current = this.options.store.read(work.title);

		if (
			current.kind === "materialized" &&
			current.fields["clerus-executor"] === work.executor &&
			current.fields["clerus-custody"] === "user"
		) {
			return;
		}
	}

	var diagnostic = {
		title: work.title,
		type: work.event.type,
		phase: infrastructure ? "materialization" : "reaction",
		error: describe(error)
	};

	result.errors.push(diagnostic);

	if (!lifecycle || infrastructure) {
		return;
	}

	try {
		diagnostic.lifecycle = lifecycle.dismiss({
			title: work.title,
			executor: work.executor,
			event: work.event,
			error: error
		});

		if (diagnostic.lifecycle.dismissed) {
			/*
				The failed reaction has already closed its scope.
				The dismissal notification is separate queued work.
			*/
			this.queue.unshift({
				title: work.title,
				executor: work.executor,
				event: { type: "dismissed" },
				incoming: undefined,
				ignoreErrors: true
			});
		}
	} catch (transitionError) {
		diagnostic.lifecycleError = describe(transitionError);
	}
};

Scheduler.prototype.drain = function () {
	if (this.running) {
		throw new Error("Cannot drain a running scheduler");
	}

	var result = {
		delivered: [],
		skipped: [],
		errors: [],
		persistent: [],
		blocked: [],
		remaining: 0
	};

	var deferred = [];

	this.running = true;

	try {
		while (this.queue.length > 0) {
			var work = this.queue.shift();
			var space = jobTitles.classify(work.title);
			var persistentWork = !!space && space.persistent;

			try {
				var handler;

				try {
					if (work.establishing) {
						if (
							this.options.store.read(work.title).kind !==
							"absent"
						) {
							throw new Error(
								"Establishment target became occupied"
							);
						}

						handler = this.options.resolveExecutor(
							work.executor
						);

						if (typeof handler !== "function") {
							throw new Error(
								"Establishment executor is unavailable"
							);
						}
					} else {
						var recipient = this.recipient(
							work.title,
							persistentWork
						);

						if (recipient.job.executor !== work.executor) {
							throw new Error(
								"Recipient executor has changed"
							);
						}

						handler = recipient.handler;
					}
				} catch (error) {
					if (persistentWork) {
						deferred.push(work);

						result.blocked.push({
							title: work.title,
							type: work.event.type,
							error: describe(error)
						});
					} else {
						result.skipped.push({
							title: work.title,
							type: work.event.type,
							error: describe(error)
						});
					}

					continue;
				}

				/*
					Select the reliability contract from the address.
					A persistent recipient must never reach
					reactions.execute() or ephemeral dismissal.
				*/
				if (persistentWork) {
					try {
						if (
							typeof this.options.executePersistent !==
							"function"
						) {
							throw new Error(
								"Persistent ingress is unavailable"
							);
						}

						var persistentResult =
							this.options.executePersistent({
								title: work.title,
								executor: work.executor,
								handler: handler,
								event: work.event,
								incoming: work.incoming
							});

						result.persistent.push({
							title: work.title,
							type: work.event.type,
							result: persistentResult
						});

						if (
							persistentResult.status === "blocked" ||
							persistentResult.status === "unavailable"
						) {
							deferred.push(work);

							result.blocked.push({
								title: work.title,
								type: work.event.type,
								result: persistentResult
							});
						} else if (
							persistentResult.status === "completed"
						) {
							result.delivered.push({
								title: work.title,
								type: work.event.type
							});
						} else {
							result.errors.push({
								title: work.title,
								type: work.event.type,
								phase: persistentResult.phase,
								error: persistentResult.error,
								result: persistentResult
							});
						}
					} catch (error) {
						result.errors.push({
							title: work.title,
							type: work.event.type,
							phase: "persistent-ingress",
							error: describe(error)
						});
					}

					continue;
				}

				try {
					var execution = {
						store: this.options.store,
						title: work.title,
						platform: this.options.platform,
						event: work.event,
						incoming: work.incoming,
						readJobs: this.options.readJobs,
						newId: this.options.newId,
						checkMessage: this.checkMessage,
						acceptMessage: this.acceptMessage,
						requireSentOutgoing: true,
						checkDeferred: this.options.checkDeferred,
						acceptDeferred: this.options.acceptDeferred
					};

					if (work.establishing) {
						execution.resolveExecutor = function (name) {
							if (name !== work.executor) {
								throw new Error(
									"Establishment executor mismatch"
								);
							}

							return handler;
						};

						reactions.establish(execution);
					} else {
						execution.handler = handler;
						reactions.execute(execution);
					}

					result.delivered.push({
						title: work.title,
						type: work.event.type
					});
				} catch (error) {
					this.handleFailure(work, error, result);
				}
			} finally {
				if (work.establishing) {
					this.pendingBirths.delete(work.title);
				}
			}
		}
	} finally {
		this.queue = deferred.concat(this.queue);
		this.running = false;
		result.remaining = this.queue.length;
	}

	return result;
};

exports.Scheduler = Scheduler;