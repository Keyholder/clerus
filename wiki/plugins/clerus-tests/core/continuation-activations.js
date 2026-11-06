/*\
title: $:/plugins/clerus/tests/core/continuation-activations.js
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

function fixture(tw, reschedule) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/continuation-activation-owner";
	var sequence = 0;
	var orders = 0;
	var ticks = [];

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "activation-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: {}
			}
		})
	}));

	function createRuntime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: function () {
				sequence++;
				return "activation-generated-" +
					String(sequence).padStart(12, "0");
			},
			resolveExecutor: function () {
				return function (event, operational) {
					if (event.type === "suspended") {
						return;
					}

					var charter = operational.get("charter");

					if (event.type === "order") {
						orders++;

						charter.defer();
						charter.defer();
						return;
					}

					assert(event.type === "tick");

					ticks.push(event.id);

					charter.setStatus({
						ticks: ticks.length
					});

					if (reschedule && ticks.length === 1) {
						charter.defer();
					}
				};
			}
		});
	}

	var runtime = createRuntime();

	var journal = runtime.continuations.accept({
		version: 2,
		id: "activation-initial-work-01",
		checks: [],
		transitions: [],
		blocks: [],
		emits: [{
			id: "activation-initial-order-01",
			event: {
				kind: "delivery",
				recipient: {
					title: owner,
					executor: "activation-test"
				},
				type: "order",
				registry: {}
			}
		}]
	});

	runtime.recover();
	runtime.drainFlows();

	return {
		wiki: wiki,
		platform: platform,
		owner: owner,
		journal: journal,
		runtime: runtime,
		restart: createRuntime,
		ticks: ticks,
		orders: function () {
			return orders;
		},
		record: function () {
			return JSON.parse(wiki.getTiddlerText(journal));
		}
	};
}

function testActivationWaits(tw) {
	var f = fixture(tw, false);

	assert(f.orders() === 1);
	assert(f.ticks.length === 0);

	var record = f.record();
	var ids = Object.keys(record.events);

	assert(record.work === null);
	assert(ids.length === 1);
	assert(record.events[ids[0]].event.kind === "activation");

	f.runtime.drainFlows();
	assert(f.ticks.length === 0);

	var report = f.runtime.runDeferred();

	assert(report.errors.length === 0);
	assert(report.activations.length === 1);
	assert(report.activations[0].result.status === "completed");
	assert(f.ticks.length === 1);
	assert(f.ticks[0] === ids[0]);
	assert(!f.wiki.tiddlerExists(f.journal));
}

function testRescheduleWaitsForNextPass(tw) {
	var f = fixture(tw, true);

	var first = f.runtime.runDeferred();

	assert(first.activations.length === 1);
	assert(first.activations[0].result.status === "completed");
	assert(f.ticks.length === 1);
	assert(f.wiki.tiddlerExists(f.journal));

	var record = f.record();
	var ids = Object.keys(record.events);

	assert(ids.length === 1);
	assert(record.events[ids[0]].event.kind === "activation");
	assert(ids[0] !== f.ticks[0]);

	var second = f.runtime.runDeferred();

	assert(second.activations.length === 1);
	assert(second.activations[0].result.status === "completed");
	assert(f.ticks.length === 2);
	assert(!f.wiki.tiddlerExists(f.journal));
}

function testActivationSurvivesRestart(tw) {
	var f = fixture(tw, false);
	var restarted = f.restart();

	restarted.recover();

	assert(f.orders() === 1);
	assert(f.ticks.length === 0);

	var report = restarted.runDeferred();

	assert(report.activations.length === 1);
	assert(report.activations[0].result.status === "completed");
	assert(f.ticks.length === 1);
	assert(!f.wiki.tiddlerExists(f.journal));
}

function testMaterializationDoesNotReplayTick(tw) {
	var f = fixture(tw, false);
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.owner && !injected) {
			injected = true;
			throw new Error("Interrupted activation materialization");
		}

		return result;
	};

	var report;

	try {
		report = f.runtime.runDeferred();
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(report.activations.length === 1);

	var result = report.activations[0].result;

	assert(result.status === "failed");
	assert(result.phase === "materialization");
	assert(f.ticks.length === 1);

	var journal = f.wiki.getTiddler(f.journal);
	var record = JSON.parse(journal.fields.text);

	assert(record.work);
	assert(Object.keys(record.events).length === 0);
	assert(journal.fields["clerus-custody"] === "user");

	f.wiki.addTiddler(new tw.Tiddler(journal, {
		"clerus-custody": f.platform
	}));

	var restarted = f.restart();

	restarted.recover();
	restarted.runDeferred();

	assert(f.ticks.length === 1);
	assert(!f.wiki.tiddlerExists(f.journal));
}

exports.run = function (tw) {
	var cases = [
		["activation waits for deferred pass", testActivationWaits],
		["rescheduled activation waits for next pass", testRescheduleWaitsForNextPass],
		["activation survives runtime replacement", testActivationSurvivesRestart],
		["accepted tick consequences do not replay handler", testMaterializationDoesNotReplayTick]
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