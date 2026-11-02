/*\
title: $:/plugins/clerus/core2/flow-scheduler.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");

var flowObligations = require(
	"$:/plugins/clerus/core2/flow-obligations.js"
);
var persistent = require(
	"$:/plugins/clerus/core2/persistent-reaction.js"
);

function key(title, id) {
	return JSON.stringify([title, id]);
}

function describe(error) {
	return {
		name: String(error && error.name || "Error"),
		message: String(error && error.message || error)
	};
}

function Scheduler(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.resolveExecutor !== "function" ||
		typeof options.newId !== "function"
	) {
		throw new Error(
			"Flow scheduler requires a store, resolver and identity source"
		);
	}

	this.options = options;
	this.queue = new Map();
	this.running = false;

	this.flows = flowObligations.create({
		store: options.store,
		platform: options.platform,
		newId: options.newId
	});
}

Scheduler.prototype.drop = function (title) {
	var removed = [];

	this.queue.forEach(function (work, identity) {
		if (work.title === title) {
			removed.push(identity);
		}
	});

	removed.forEach(function (identity) {
		this.queue.delete(identity);
	}, this);
};

Scheduler.prototype.track = function (title) {
	var stored = this.options.store.read(title);

	if (
		stored.kind !== "materialized" ||
		stored.fields["clerus-custody"] !== this.options.platform
	) {
		this.drop(title);
		return;
	}

	var record = this.flows.read(title).record;

	/*
		The queue is derived. Replace its representation of this
		journal from the current authoritative state.
	*/
	this.drop(title);

	if (record.active !== null) {
		return;
	}

	record.pending.forEach(function (message) {
		this.queue.set(key(title, message.id), {
			title: title,
			id: message.id
		});
	}, this);
};

Scheduler.prototype.drain = function () {
	if (this.running) {
		throw new Error("Cannot drain a running flow scheduler");
	}

	var report = {
		completed: [],
		blocked: [],
		unavailable: [],
		errors: [],
		remaining: 0
	};

	var attempted = new Set();

	this.running = true;

	try {
		while (true) {
			var selected = null;

			this.queue.forEach(function (work, identity) {
				if (selected === null && !attempted.has(identity)) {
					selected = {
						identity: identity,
						title: work.title,
						id: work.id
					};
				}
			});

			if (selected === null) {
				break;
			}

			attempted.add(selected.identity);

			var message;

			try {
				this.track(selected.title);

				if (!this.queue.has(selected.identity)) {
					continue;
				}

				message = this.flows.pending(selected.title).find(
					function (candidate) {
						return candidate.id === selected.id;
					}
				);

				if (!message) {
					this.queue.delete(selected.identity);
					continue;
				}
			} catch (error) {
				this.drop(selected.title);

				report.errors.push({
					title: selected.title,
					messageId: selected.id,
					phase: "journal",
					error: describe(error)
				});

				continue;
			}

			var recipient = this.options.store.read(
				message.recipient.title
			);

			var space = jobTitles.classify(
				message.recipient.title
			);

			if (!space || !space.persistent) {
				report.unavailable.push({
					title: selected.title,
					messageId: selected.id,
					reason: "recipient-mode-not-supported"
				});

				continue;
			}

			if (
				recipient.kind !== "materialized" ||
				recipient.fields.type !== "application/json" ||
				recipient.fields["clerus-executor"] !==
					message.recipient.executor
			) {
				report.unavailable.push({
					title: selected.title,
					messageId: selected.id,
					reason: "recipient-unavailable"
				});

				continue;
			}

			if (
				recipient.fields["clerus-suspended"] === "yes" &&
				recipient.fields["clerus-custody"] ===
					this.options.platform
			) {
				report.blocked.push({
					title: selected.title,
					messageId: selected.id,
					reason: "resumption-required"
				});

				continue;
			}

			var handler = this.options.resolveExecutor(
				message.recipient.executor
			);

			if (typeof handler !== "function") {
				report.unavailable.push({
					title: selected.title,
					messageId: selected.id,
					reason: "executor-unavailable"
				});

				continue;
			}

			var result = persistent.execute({
				store: this.options.store,
				title: message.recipient.title,
				platform: this.options.platform,
				handler: handler,
				newId: this.options.newId,

				flow: {
					title: selected.title,
					messageId: selected.id
				}
			});

			var entry = {
				title: selected.title,
				messageId: selected.id,
				recipient: message.recipient.title,
				result: result
			};

			if (result.status === "completed") {
				report.completed.push(entry);
			} else if (result.status === "blocked") {
				report.blocked.push(entry);
			} else if (result.status === "unavailable") {
				report.unavailable.push(entry);
			} else {
				report.errors.push(entry);
			}

			try {
				this.track(selected.title);
			} catch (error) {
				this.drop(selected.title);

				report.errors.push({
					title: selected.title,
					messageId: selected.id,
					phase: "journal-refresh",
					error: describe(error)
				});
			}
		}
	} finally {
		this.running = false;
		report.remaining = this.queue.size;
	}

	return report;
};

exports.Scheduler = Scheduler;