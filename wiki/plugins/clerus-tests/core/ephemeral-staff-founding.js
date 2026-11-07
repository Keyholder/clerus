/*\
title: $:/plugins/clerus/tests/core/ephemeral-staff-founding.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var observation = require(
	"$:/plugins/clerus/tests/protocol-observation.js"
);

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw, failInitialization) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var founder = "$:/clerus/jobs/ephemeral-staff-founder";
	var project = "Core2 Ephemeral Staff Project";
	var sequence = 0;
	var initialized = 0;
	var dismissed = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: founder,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "founder",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			root: {
				form: "mission",
				project: project,
				role: [],
				link: "10",
				issued: "1",
				children: { item: "10/1" }
			},
			assignment: {
				form: "mission",
				project: project,
				role: ["item"],
				link: "10/1",
				issued: "0",
				children: {}
			},
			contract: {
				form: "contract",
				executor: "worker",
				temp: true
			}
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		text: JSON.stringify({
			task: {},
			parts: {
				item: {
					task: { value: 42 },
					parts: {}
				}
			}
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "ephemeral-staff-" +
				String(sequence).padStart(12, "0");
		},

		resolveExecutor: function (name) {
			if (name === "founder") {
				return function (event, operational, incoming) {
					if (event.type === "report") {
						incoming.move(
							"result",
							operational,
							"received"
						);
						return;
					}

					var worker = operational.get("charter").createTitle(
						"worker",
						operational,
						"worker",
						true
					);

					var outgoing = operational.outgoing();

					operational.move("contract", outgoing, "contract");
					operational.move(
						"assignment",
						outgoing,
						"assignment"
					);

					worker.order(outgoing);
				};
			}

			if (name === "worker") {
				return function (event, operational, incoming) {
					if (event.type === "dismissed") {
						dismissed++;
						return;
					}

					if (event.type === "report-now") {
						var outgoing = operational.outgoing();

						operational.copy("result", outgoing, "result");
						operational.get("mission").report(outgoing);
						return;
					}

					initialized++;

					assert(event.type === "order");
					assert(event.id);
					assert(!wiki.getTiddler(event.title));

					var charter = incoming.get("contract").accept(
						"charter",
						{ phase: "starting" }
					);

					assert(wiki.getTiddler(event.title));

					var mission = incoming.get("assignment");

					assert(mission.inspect().active);
					assert(mission.task().value === 42);

					incoming.move(
						"assignment",
						operational,
						"mission"
					);

					charter.createMemo(
						{ value: 42 },
						operational,
						"result"
					);

					if (failInitialization) {
						throw new Error("Ephemeral initialization failed");
					}

					charter.setStatus({ phase: "running" });
				};
			}
		}
	});

	return {
		wiki: wiki,
		platform: platform,
		founder: founder,
		runtime: runtime,

		workerTitle: function () {
			return JSON.parse(
				wiki.getTiddler(founder).fields.text
			).worker;
		},

		initialized: function () {
			return initialized;
		},

		dismissed: function () {
			return dismissed;
		}
	};
}

function testFoundingAndReport(tw) {
	var f = fixture(tw, false);

	var founded = f.runtime.dispatch(
		f.founder,
		{ type: "found" }
	);

	assert(founded.status === "completed");

	var attempts = observation.attempts(founded.flow);

	assert(attempts.errors.length === 0);
	assert(attempts.completed.length === 1);

	assert(f.initialized() === 1);

	var worker = f.workerTitle();

	assert(
		worker.indexOf(
			"$:/temp/clerus/jobs/" + f.platform + "/"
		) === 0
	);

	assert(f.wiki.getTiddler(worker));
	assert(!f.wiki.getTiddler(founded.obligation));

	var reported = f.runtime.dispatch(
		worker,
		{ type: "report-now" }
	);

	assert(reported.errors.length === 0);
	assert(reported.persistent.length === 1);
	assert(reported.persistent[0].result.status === "completed");

	var registry = JSON.parse(
		f.wiki.getTiddler(f.founder).fields.text
	);

	assert(registry.received.data.value === 42);
}

function testFailedInitializationPreservesDocuments(tw) {
	var f = fixture(tw, true);

	var result = f.runtime.dispatch(
		f.founder,
		{ type: "found" }
	);

	var attempts = observation.attempts(result.flow);

	assert(attempts.errors.length === 1);
	assert(attempts.errors[0].result.lifecycle.dismissed);

	assert(f.initialized() === 1);
	assert(f.dismissed() === 1);

	var worker = f.wiki.getTiddler(f.workerTitle());
	var registry = JSON.parse(worker.fields.text);

	assert(worker.fields["clerus-custody"] === "user");

	// Already performed ephemeral effects remain intact.
	assert(registry.mission);
	assert(registry.result.data.value === 42);
	assert(registry.charter.status.phase === "starting");

	assert(!f.runtime.inspect().missions.active.some(
		function (entry) {
			return entry.title === f.workerTitle();
		}
	));

	var journal = f.wiki.getTiddler(result.obligation);

	assert(journal.fields["clerus-custody"] === "user");

	var record = JSON.parse(journal.fields.text);
	var ids = Object.keys(record.events);

	assert(record.version === 2);
	assert(record.kind === "continuation");
	assert(record.work === null);
	assert(record.diagnostics.length === 1);
	assert(ids.length === 1);
	assert(record.events[ids[0]].mode === "paused");
	assert(record.events[ids[0]].event.establishing === true);
}

function testInterruptedBirthDoesNotReinitialize(tw) {
	var f = fixture(tw, false);
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (
			!injected &&
			effect.before === null &&
			effect.after &&
			effect.after["clerus-executor"] === "worker"
		) {
			injected = true;
			throw new Error("Interrupted after ephemeral birth");
		}

		return result;
	};

	var result;

	try {
		result = f.runtime.dispatch(
			f.founder,
			{ type: "found" }
		);
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);

	var attempts = observation.attempts(result.flow);

	assert(attempts.errors.length === 1);
	assert(attempts.errors[0].result.phase === "materialization");
	assert(!attempts.errors[0].result.lifecycle);

	assert(f.initialized() === 1);
	assert(f.dismissed() === 0);

	var workerTitle = f.workerTitle();
	var worker = f.wiki.getTiddler(workerTitle);
	var registry = JSON.parse(worker.fields.text);

	// The birth write happened, but accept() did not return.
	assert(worker);
	assert(worker.fields["clerus-custody"] === f.runtime.platform);
	assert(registry.charter.status.phase === "starting");
	assert(!registry.mission);
	assert(!registry.result);

	var body = worker.fields.text;
	var pending = f.runtime.continuations.pending(
		result.obligation
	);

	assert(pending.length === 1);
	assert(pending[0].event.establishing);
	assert(pending[0].event.registry.contract.form === "contract");
	assert(pending[0].event.registry.assignment.form === "mission");

	var retried = f.runtime.drainFlows();
	var retriedAttempts = observation.attempts(retried);

	assert(retriedAttempts.unavailable.length === 1);
	assert(
		retriedAttempts.unavailable[0].reason ===
			"establishment-target-occupied"
	);
	assert(retried.summary.waiting.deliveries.ready === 1);

	assert(f.initialized() === 1);
	assert(f.dismissed() === 0);
	assert(f.wiki.getTiddler(workerTitle).fields.text === body);
}

function isBirthAcknowledgement(effect) {
	if (
		!effect.before ||
		!effect.after ||
		effect.before["clerus-wal-kind"] !== "continuation" ||
		effect.after["clerus-wal-kind"] !== "continuation"
	) {
		return false;
	}

	var before = JSON.parse(effect.before.text);
	var after = JSON.parse(effect.after.text);
	var ids = Object.keys(before.events);

	return (
		before.work === null &&
		ids.length === 1 &&
		before.events[ids[0]].mode === "ready" &&
		before.events[ids[0]].event.establishing === true &&
		after.work === null &&
		Object.keys(after.events).length === 0
	);
}

function testUnrecordedAcknowledgementPreservesObligation(tw) {
	var f = fixture(tw, false);
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		if (
			!injected &&
			isBirthAcknowledgement(effect)
		) {
			injected = true;

			throw new Error(
				"Interrupted before birth acknowledgement"
			);
		}

		return originalApply.call(this, effect);
	};

	var result;

	try {
		result = f.runtime.dispatch(
			f.founder,
			{ type: "found" }
		);
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);

	var attempts = observation.attempts(result.flow);

	assert(attempts.errors.length === 1);
	assert(attempts.errors[0].result.phase === "acknowledgement");
	assert(attempts.errors[0].result.acceptanceUncertain);

	assert(f.initialized() === 1);

	var workerTitle = f.workerTitle();
	var worker = f.wiki.getTiddler(workerTitle);
	var body = worker.fields.text;
	var registry = JSON.parse(body);

	assert(registry.charter.status.phase === "running");
	assert(registry.mission);
	assert(registry.result.data.value === 42);
	assert(
		f.runtime.continuations.pending(
			result.obligation
		).length === 1
	);

	/*
		Recovery cannot infer successful initialization merely
		from the presence of a plausible operational registry.
	*/
	f.runtime.recover();

	var retried = f.runtime.drainFlows();

	assert(
		observation.attempts(retried).unavailable.length === 1
	);
	assert(retried.summary.waiting.deliveries.ready === 1);
	assert(f.initialized() === 1);
	assert(f.dismissed() === 0);
	assert(f.wiki.getTiddler(workerTitle).fields.text === body);
}

function testRecordedAcknowledgementFinishesWithoutReinitialization(tw) {
	var f = fixture(tw, false);
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (
			!injected &&
			isBirthAcknowledgement(effect)
		) {
			injected = true;

			throw new Error(
				"Interrupted after birth acknowledgement"
			);
		}

		return result;
	};

	var result;

	try {
		result = f.runtime.dispatch(
			f.founder,
			{ type: "found" }
		);
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);

	var attempts = observation.attempts(result.flow);

	assert(attempts.errors.length === 1);
	assert(attempts.errors[0].result.phase === "acknowledgement");

	assert(f.initialized() === 1);

	var journal = f.wiki.getTiddler(result.obligation);
	var record = JSON.parse(journal.fields.text);

	assert(record.version === 2);
	assert(record.kind === "continuation");
	assert(record.work === null);
	assert(Object.keys(record.events).length === 0);
	assert(record.diagnostics.length === 0);

	var workerTitle = f.workerTitle();
	var body = f.wiki.getTiddler(workerTitle).fields.text;

	var recovery = f.runtime.recover();

	assert(recovery.entries.some(function (entry) {
		return entry.title === result.obligation &&
			entry.status === "completed";
	}));

	assert(!f.wiki.getTiddler(result.obligation));
	assert(f.initialized() === 1);
	assert(f.dismissed() === 0);
	assert(f.wiki.getTiddler(workerTitle).fields.text === body);

	var drained = f.runtime.drainFlows();

	assert(
		observation.attempts(drained).completed.length === 0
	);
	assert(drained.summary.waiting.deliveries.ready === 0);
}

exports.run = function (tw) {
	var cases = [
		["ephemeral staff founding: persistent founder receives worker report", testFoundingAndReport],
		["ephemeral staff founding: failed initializer preserves documents", testFailedInitializationPreservesDocuments],
		["ephemeral staff founding: interrupted birth does not reinitialize occupied address", testInterruptedBirthDoesNotReinitialize],
		["ephemeral staff founding: unrecorded acknowledgement preserves the obligation", testUnrecordedAcknowledgementPreservesObligation],
		["ephemeral staff founding: recorded acknowledgement completes without replay", testRecordedAcknowledgementFinishesWithoutReinitialization]
	];

	var results = cases.map(function (item) {
		try {
			item[1](tw);

			return {
				name: item[0],
				passed: true,
				error: null
			};
		} catch (error) {
			return {
				name: item[0],
				passed: false,
				error: String(error.stack || error)
			};
		}
	});

	return {
		passed: results.every(function (result) {
			return result.passed;
		}),
		results: results
	};
};