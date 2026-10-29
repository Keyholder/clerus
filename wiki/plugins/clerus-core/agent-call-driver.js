/*\
title: $:/plugins/clerus/core/agent-call-driver.js
type: application/javascript
module-type: library
\*/

"use strict";

var WorkPlan =
	require("$:/plugins/clerus/core/work-plan.js").WorkPlan;
var deferredEffects =
	require("$:/plugins/clerus/core/deferred-effect.js");
var agentCalls =
	require("$:/plugins/clerus/core/document-agent-call.js");
var copyJSON = require("$:/plugins/clerus/core/json.js").copy;

function describe(error) {
	return {
		name: error && error.name ? String(error.name) : "Error",
		message: String(error && error.message || error)
	};
}

function Driver(options) {
	this.dispatcher = options.dispatcher;
	this.transport = options.transport;
	this.running = new Map();
	this.errors = [];
	this.started = false;
}

Driver.prototype.key = function (title, key) {
	return JSON.stringify([title, key]);
};

Driver.prototype.current = function (title, key, expected) {
	var dispatcher = this.dispatcher;
	var job = dispatcher.runtime.inspect().jobs.find(function (candidate) {
		return candidate.title === title;
	});

	if (
		!job ||
		!job.valid ||
		!job.local ||
		!job.owned ||
		!job.persistent ||
		dispatcher.materializationBlockers(job).length > 0
	) {
		return null;
	}

	var document = job.registry[key];

	try {
		agentCalls.validate(document);
	} catch (error) {
		return null;
	}

	if (
		document.id !== expected.id ||
		document.operation !== expected.operation ||
		document.phase !== expected.phase ||
		JSON.stringify(document) !== JSON.stringify(expected)
	) {
		return null;
	}

	return job;
};

Driver.prototype.transition = function (
	title,
	key,
	expected,
	replacement,
	notify
) {
	var job = this.current(title, key, expected);

	if (!job) {
		return false;
	}

	var dispatcher = this.dispatcher;
	var plan = new WorkPlan({
		wiki: dispatcher.runtime.wiki,
		Wiki: dispatcher.Wiki,
		Tiddler: dispatcher.Tiddler
	});

	try {
		var owner = plan.view.getTiddler(title);
		var registry = JSON.parse(owner.fields.text);

		Object.defineProperty(registry, key, {
			value: copyJSON(replacement),
			enumerable: true,
			writable: true,
			configurable: true
		});

		plan.patch(title, {
			text: JSON.stringify(registry)
		});

		if (notify) {
			dispatcher.messageSequence++;

			plan.defer(deferredEffects.create({
				id: dispatcher.messageSession + "-agent-settled-" +
					dispatcher.messageSequence.toString(36),
				recipient: {
					title: job.title,
					executor: job.executor,
					platform: dispatcher.runtime.platform
				}
			}));
		}

		plan.commit(function (compiled) {
			if (notify) {
				var journal = dispatcher.flowWal.register(
					job,
					plan.initial(title),
					compiled
				);

				return dispatcher.runFlow(journal);
			}

			return dispatcher.wal.commit(job, compiled, {
				ownerState: plan.initial(title)
			});
		});

		return true;
	} finally {
		if (plan.state === "open") {
			plan.abort();
		}
	}
};

Driver.prototype.settle = function (
	title,
	key,
	expected,
	phase,
	payload
) {
	var replacement = copyJSON(expected);

	replacement.phase = phase;

	if (phase === "completed") {
		var response = copyJSON(payload);

		if (response === undefined) {
			throw new Error("Agent transport response must be JSON");
		}

		replacement.response = response;
	} else {
		replacement.error = copyJSON(payload);
	}

	return this.transition(
		title,
		key,
		expected,
		replacement,
		true
	);
};

Driver.prototype.launch = function (title, key, queued) {
	var running = copyJSON(queued);
	running.phase = "running";

	if (!this.transition(title, key, queued, running, false)) {
		return;
	}

	var identity = this.key(title, key);
	var token = {
		document: running
	};

	this.running.set(identity, token);

	// Defer the actual transport call until the synchronous scan ends.
	Promise.resolve().then(function () {
		if (
			!this.started ||
			this.running.get(identity) !== token ||
			!this.current(title, key, running)
		) {
			return;
		}

		return Promise.resolve().then(function () {
			if (
				!this.started ||
				this.running.get(identity) !== token ||
				!this.current(title, key, running)
			) {
				return;
			}

			return this.transport(copyJSON(running.request), {
				id: running.operation,
				title: title,
				key: key
			});
		}.bind(this)).then(function (response) {
			if (
				!this.started ||
				this.running.get(identity) !== token ||
				!this.current(title, key, running)
			) {
				return;
			}

			this.settle(
				title,
				key,
				running,
				"completed",
				response
			);
		}.bind(this), function (error) {
			if (
				!this.started ||
				this.running.get(identity) !== token
			) {
				return;
			}

			this.settle(
				title,
				key,
				running,
				error && error.definitelyNotExecuted === true
					? "failed"
					: "uncertain",
				describe(error)
			);
		}.bind(this));
	}.bind(this)).catch(function (error) {
		// Includes failures to serialize or commit the response.
		// Never reinterpret these as a fresh transport failure.
		this.errors.push({
			title: title,
			key: key,
			operation: running.operation,
			error: describe(error)
		});
	}.bind(this)).then(function () {
		if (this.running.get(identity) === token) {
			this.running.delete(identity);
		}

		if (this.started) {
			this.dispatcher.scheduleOrders();
		}
	}.bind(this));
};

Driver.prototype.scan = function () {
	if (!this.started) {
		return;
	}

	var dispatcher = this.dispatcher;

	dispatcher.runtime.inspect().jobs.forEach(function (job) {
		if (
			!job.valid ||
			!job.local ||
			!job.owned ||
			!job.persistent ||
			dispatcher.materializationBlockers(job).length > 0
		) {
			return;
		}

		Object.keys(job.registry).forEach(function (key) {
			var document = job.registry[key];

			if (!document || document.form !== "agent-call") {
				return;
			}

			try {
				agentCalls.validate(document);

				if (document.phase === "queued") {
					this.launch(job.title, key, document);
				} else if (document.phase === "running") {
					var token = this.running.get(this.key(job.title, key));

					if (
						!token ||
						JSON.stringify(token.document) !==
							JSON.stringify(document)
					) {
						this.settle(
							job.title,
							key,
							document,
							"uncertain",
							{
								name: "InterruptedAgentCall",
								message: "Transport outcome is unknown"
							}
						);
					}
				}
			} catch (error) {
				this.errors.push({
					title: job.title,
					key: key,
					error: describe(error)
				});
			}
		}, this);
	}, this);
};

Driver.prototype.start = function () {
	this.started = true;
};

Driver.prototype.stop = function () {
	this.started = false;
	this.running.clear();
};

exports.Driver = Driver;