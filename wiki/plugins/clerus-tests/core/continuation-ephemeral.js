/*\
title: $:/plugins/clerus/tests/core/continuation-ephemeral.js
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

function fixture(tw, settings) {
	settings = settings || {};

	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var target =
		"$:/temp/clerus/jobs/" + platform + "/v2-ephemeral-target";

	var sequence = 0;
	var calls = [];

	if (!settings.establishing) {
		wiki.addTiddler(new tw.Tiddler({
			title: target,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "ephemeral-test",
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: {}
				},
				counter: {
					form: "memo",
					data: 0
				}
			})
		}));
	}

	function createRuntime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: function () {
				sequence++;
				return "ephemeral-v2-generated-" +
					String(sequence).padStart(12, "0");
			},
			resolveExecutor: function () {
				return function (event, operational, incoming) {
					if (event.type === "dismissed") {
						return;
					}

					calls.push(event.id);

					if (settings.establishing) {
						incoming.get("contract").accept(
							"charter",
							{ phase: "initialized" }
						);

						incoming.move(
							"input",
							operational,
							"received"
						);

						return;
					}

					var counter = operational.get("counter");

					counter.setData(counter.data() + 1);

					if (settings.fail) {
						throw new Error("Ephemeral handler failed");
					}

					incoming.destroy("input");
				};
			}
		});
	}

	var runtime = createRuntime();

	var event = {
		kind: "delivery",
		recipient: {
			title: target,
			executor: "ephemeral-test"
		},
		type: "order",
		registry: {
			input: {
				form: "memo",
				data: 42
			}
		}
	};

	if (settings.establishing) {
		event.establishing = true;
		event.registry.contract = {
			form: "contract",
			temp: true,
			executor: "ephemeral-test"
		};
	}

	var id = "ephemeral-v2-event-000001";

	var journal = runtime.continuations.accept({
		version: 2,
		id: "ephemeral-v2-work-0000001",
		checks: [],
		transitions: [],
		blocks: [],
		emits: [{
			id: id,
			event: event
		}]
	});

	runtime.recover();

	return {
		wiki: wiki,
		platform: platform,
		target: target,
		id: id,
		journal: journal,
		runtime: runtime,
		restart: createRuntime,
		calls: calls,
		counter: function () {
			return JSON.parse(
				wiki.getTiddlerText(target)
			).counter.data;
		}
	};
}

function errors(report) {
	var result = [];

	report.continuations.forEach(function (pass) {
		result = result.concat(pass.errors);
	});

	return result;
}

function testSuccessfulDelivery(tw) {
	var f = fixture(tw);
	var report = f.runtime.drainFlows();

	assert(errors(report).length === 0);
	assert(f.calls.length === 1);
	assert(f.calls[0] === f.id);
	assert(f.counter() === 1);
	assert(!f.wiki.tiddlerExists(f.journal));
}

function testInterruptionBeforeAcknowledgement(tw) {
	var f = fixture(tw);
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		if (
			effect.title === f.journal &&
			effect.before &&
			effect.after &&
			!injected
		) {
			var before = JSON.parse(effect.before.text);
			var after = JSON.parse(effect.after.text);

			if (
				before.events[f.id] &&
				!after.events[f.id]
			) {
				injected = true;
				throw new Error("Before acknowledgement write");
			}
		}

		return originalApply.call(this, effect);
	};

	var report;

	try {
		report = f.runtime.drainFlows();
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(errors(report).length === 1);
	assert(errors(report)[0].result.phase === "acknowledgement");
	assert(f.counter() === 1);
	assert(f.calls.length === 1);

	var record = JSON.parse(
		f.wiki.getTiddlerText(f.journal)
	);

	assert(record.events[f.id].mode === "ready");

	var restarted = f.restart();

	restarted.recover();
	restarted.drainFlows();

	assert(f.counter() === 2);
	assert(f.calls.length === 2);
	assert(f.calls[0] === f.calls[1]);
	assert(!f.wiki.tiddlerExists(f.journal));
}

function testRecordedAcknowledgementPreventsReplay(tw) {
	var f = fixture(tw);
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (
			effect.title === f.journal &&
			effect.after &&
			!injected
		) {
			var record = JSON.parse(effect.after.text);

			if (
				record.work === null &&
				!record.events[f.id]
			) {
				injected = true;
				throw new Error("After acknowledgement write");
			}
		}

		return result;
	};

	try {
		var report = f.runtime.drainFlows();
		assert(errors(report).length === 1);
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(f.counter() === 1);
	assert(f.calls.length === 1);

	var restarted = f.restart();

	restarted.recover();
	restarted.drainFlows();

	assert(f.counter() === 1);
	assert(f.calls.length === 1);
	assert(!f.wiki.tiddlerExists(f.journal));
}

function testFailureKeepsPartialEffects(tw) {
	var f = fixture(tw, { fail: true });
	var report = f.runtime.drainFlows();

	assert(errors(report).length === 1);
	assert(errors(report)[0].result.phase === "reaction");
	assert(f.calls.length === 1);
	assert(f.counter() === 1);

	var journal = f.wiki.getTiddler(f.journal);
	var record = JSON.parse(journal.fields.text);

	assert(record.events[f.id].mode === "paused");
	assert(record.events[f.id].event.registry.input.data === 42);
	assert(journal.fields["clerus-custody"] === "user");
	assert(
		f.wiki.getTiddler(f.target).fields["clerus-custody"] ===
			"user"
	);

	f.runtime.drainFlows();
	assert(f.calls.length === 1);
}

function testEphemeralEstablishment(tw) {
	var f = fixture(tw, { establishing: true });

	assert(!f.wiki.tiddlerExists(f.target));

	var report = f.runtime.drainFlows();

	assert(errors(report).length === 0);
	assert(f.calls.length === 1);
	assert(!f.wiki.tiddlerExists(f.journal));

	var registry = JSON.parse(
		f.wiki.getTiddlerText(f.target)
	);

	assert(registry.charter.status.phase === "initialized");
	assert(registry.received.data === 42);
}

exports.run = function (tw) {
	var cases = [
		["ephemeral delivery is explicitly acknowledged", testSuccessfulDelivery],
		["interruption before acknowledgement may repeat effects", testInterruptionBeforeAcknowledgement],
		["recorded acknowledgement prevents replay", testRecordedAcknowledgementPreventsReplay],
		["reaction failure preserves partial ephemeral effects", testFailureKeepsPartialEffects],
		["ephemeral establishment uses the same event protocol", testEphemeralEstablishment]
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