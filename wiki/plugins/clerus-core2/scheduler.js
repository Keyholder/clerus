/*\
title: $:/plugins/clerus/core2/scheduler.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");
var reactions = require("$:/plugins/clerus/core2/reaction.js");
var roles = require("$:/plugins/clerus/core2/roles.js");

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

	this.options = options;
	this.queue = [];
	this.running = false;

	this.checkMessage = this.checkMessage.bind(this);
	this.acceptMessage = this.acceptMessage.bind(this);

	this.pendingBirths = new Set();
}

Scheduler.prototype.recipient = function (title) {
	var space = jobTitles.classify(title);

	if (
		!space ||
		space.persistent ||
		space.platform !== this.options.platform
	) {
		throw new Error(
			"This scheduler supports only local ephemeral recipients"
		);
	}

	var stored = this.options.store.read(title);

	if (stored.kind !== "materialized") {
		throw new Error("Recipient is not materialized");
	}

	var job = schemas.ephemeralJob(
		stored.fields,
		this.options.platform
	);

	var handler = this.options.resolveExecutor(job.executor);

	if (typeof handler !== "function") {
		throw new Error("Recipient executor is unavailable");
	}

	return {
		job: job,
		handler: handler
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

	var recipient = this.recipient(message.recipient);

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

Scheduler.prototype.drain = function () {
	if (this.running) {
		throw new Error("Cannot drain a running scheduler");
	}

	var result = {
		delivered: [],
		skipped: [],
		errors: []
	};

	this.running = true;

	try {
		while (this.queue.length > 0) {
			var work = this.queue.shift();

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
						var recipient = this.recipient(work.title);

						if (recipient.job.executor !== work.executor) {
							throw new Error(
								"Recipient executor has changed"
							);
						}

						handler = recipient.handler;
					}
				} catch (error) {
					result.skipped.push({
						title: work.title,
						type: work.event.type,
						error: describe(error)
					});

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
						acceptMessage: this.acceptMessage
					};

					if (work.establishing) {
						/*
						Use the handler selected for this delivery.
						reaction.establish() still checks the contract.
						*/
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
					result.errors.push({
						title: work.title,
						type: work.event.type,
						error: describe(error)
					});
				}
			} finally {
				if (work.establishing) {
					this.pendingBirths.delete(work.title);
				}
			}
		}
	} finally {
		this.running = false;
	}

	return result;
};

exports.Scheduler = Scheduler;