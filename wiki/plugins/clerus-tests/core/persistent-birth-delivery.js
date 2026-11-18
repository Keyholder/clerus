/*\
title: $:/plugins/clerus/tests/core/persistent-birth-delivery.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw, initialize) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = "$:/clerus/jobs/birth-delivery-source";
	var target = "$:/clerus/jobs/birth-delivery-target";
	var sequence = 0;
	var calls = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: source,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "source",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: {}
			},
			target: target
		})
	}));

	var f;

	function createRuntime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,

			newId: function () {
				sequence++;

				return "birth-delivery-" +
					String(sequence).padStart(12, "0");
			},

			resolveExecutor: function (name) {
				if (name !== "worker") {
					return undefined;
				}

				return function (event, operational, incoming) {
					calls++;

					return initialize(
						f,
						event,
						operational,
						incoming
					);
				};
			}
		});
	}

	var runtime = createRuntime();

	var journal = runtime.continuations.accept({
		version: 2,
		id: "birth-delivery-work-0001",
		checks: [],
		transitions: [],
		blocks: [],
		emits: [{
			id: "birth-delivery-message-0001",
			event: {
				kind: "delivery",
				type: "order",
				establishing: true,
				recipient: {
					title: target,
					executor: "worker"
				},
				registry: {
					contract: {
						form: "contract",
						executor: "worker",
						temp: false,
						book: { instruction: "initialize" }
					},
					note: {
						form: "memo",
						data: 42
					}
				}
			}
		}]
	});

	runtime.continuations.resume(journal);

	f = {
		wiki: wiki,
		platform: platform,
		source: source,
		target: target,
		journal: journal,
		runtime: runtime,
		createRuntime: createRuntime,

		calls: function () {
			return calls;
		}
	};

	return f;
}

function initialize(f, event, operational, incoming) {
	assert(event.type === "order");
	assert(event.id === "birth-delivery-message-0001");
	assert(!("source" in event));
	assert(!f.wiki.getTiddler(f.target));

	var charter = incoming.get("contract").accept(
		"charter",
		{ phase: "starting" }
	);

	assert(!f.wiki.getTiddler(f.target));
	assert(charter.book().instruction === "initialize");

	incoming.move("note", operational, "received");
	charter.setStatus({ phase: "running" });
}

function testSuccessfulBirth(tw) {
	var f = fixture(tw, initialize);

	var report = f.runtime.drainFlows();

	assert(report.errors.length === 0);
	assert(report.completed.length === 1);
	assert(report.remaining === 0);
	assert(f.calls() === 1);
	assert(!f.wiki.getTiddler(f.journal));

	var registry = JSON.parse(
		f.wiki.getTiddler(f.target).fields.text
	);

	assert(registry.charter.status.phase === "running");
	assert(registry.received.data === 42);
}

function testRejectedInitializationCreatesNothing(tw) {
	var f = fixture(tw, function (
		f,
		event,
		operational,
		incoming
	) {
		initialize(f, event, operational, incoming);
		throw new Error("Initialization rejected");
	});

	var report = f.runtime.drainFlows();

	assert(report.errors.length === 1);
	assert(report.errors[0].result.phase === "reaction");
	assert(f.calls() === 1);
	assert(!f.wiki.getTiddler(f.target));

	var journal = f.wiki.getTiddler(f.journal);
	var record = JSON.parse(journal.fields.text);

	assert(journal.fields["clerus-custody"] === "user");
	assert(record.version === 2);
	assert(record.kind === "continuation");
	assert(record.work === null);
	assert(record.diagnostics.length === 1);

	var id = "birth-delivery-message-0001";

	assert(Object.keys(record.events).length === 1);
	assert(record.events[id].mode === "paused");
	assert(record.events[id].event.establishing === true);
	assert(
		record.events[id].event.registry.contract.form === "contract"
	);
	assert(record.events[id].event.registry.note.data === 42);
	assert(
		record.diagnostics[0].error.message ===
			"Initialization rejected"
	);
}

function testInterruptedBirthDoesNotRepeatInitialization(tw) {
	var f = fixture(tw, initialize);
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.target && !injected) {
			injected = true;
			throw new Error("Interrupted after birth write");
		}

		return result;
	};

	var report;

	try {
		report = f.runtime.drainFlows();
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(report.errors.length === 1);
	assert(report.errors[0].result.phase === "materialization");
	assert(f.calls() === 1);
	assert(f.wiki.getTiddler(f.target));

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.journal),
		{ "clerus-custody": f.platform }
	));

	var restarted = f.createRuntime();

	restarted.recover();

	assert(f.calls() === 1);
	assert(!f.wiki.getTiddler(f.journal));

	var registry = JSON.parse(
		f.wiki.getTiddler(f.target).fields.text
	);

	assert(registry.charter.status.phase === "running");
	assert(registry.received.data === 42);
}

function testOccupiedAddressIsPreserved(tw) {
	var f = fixture(tw, initialize);

	f.wiki.addTiddler(new tw.Tiddler({
		title: f.target,
		text: "intervention"
	}));

	var report = f.runtime.drainFlows();

	assert(report.unavailable.length === 1);
	assert(report.remaining === 1);
	assert(f.calls() === 0);
	assert(f.wiki.getTiddlerText(f.target) === "intervention");
	assert(f.runtime.continuations.pending(f.journal).length === 1);
}

exports.run = function (tw) {
	var cases = [
		["persistent birth delivery: initialization is explicitly accepted", testSuccessfulBirth],
		["persistent birth delivery: failed initialization creates no job", testRejectedInitializationCreatesNothing],
		["persistent birth delivery: interrupted birth does not repeat initializer", testInterruptedBirthDoesNotRepeatInitialization],
		["persistent birth delivery: occupied address remains pending", testOccupiedAddressIsPreserved]
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