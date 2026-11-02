/*\
title: $:/plugins/clerus/core/tests/runtime-defer.js
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
	var director = "$:/clerus/jobs/runtime-defer-director";
	var worker = "$:/clerus/jobs/runtime-defer-worker";
	var project = "Core2 Runtime Defer Project";

	var sequence = 0;
	var calls = { ticks: 0, reports: 0 };

	function write(title, executor, registry) {
		registry.charter = {
			form: "charter",
			status: {}
		};

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(registry)
		}));
	}

	write(director, "director", {
		worker: worker,
		note: { form: "memo", data: 42 },
		mission: {
			form: "mission",
			project: project,
			role: [],
			link: "10",
			issued: "1",
			children: { item: "10/1" }
		}
	});

	write(worker, "worker", {
		evidence: { form: "memo", data: 42 },
		mission: {
			form: "mission",
			project: project,
			role: ["item"],
			link: "10/1",
			issued: "0",
			children: {}
		}
	});

	function createRuntime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,

			newId: function () {
				sequence++;

				return "runtime-defer-" +
					String(sequence).padStart(12, "0");
			},

			resolveExecutor: function (name) {
				if (name === "director") {
					return function (event, operational, incoming) {
						if (event.type === "report") {
							calls.reports++;
							incoming.destroy("result");
							return;
						}

						var outgoing = operational.outgoing();

						operational.copy("note", outgoing, "instruction");
						operational.get("worker").order(outgoing);
					};
				}

				if (name === "worker") {
					return function (event, operational, incoming) {
						if (event.type === "order") {
							incoming.destroy("instruction");

							operational.get("charter").defer();
							operational.get("charter").defer();
							return;
						}

						assert(event.type === "tick");
						calls.ticks++;

						operational.get("charter").setStatus({
							phase: "ticked"
						});

						var outgoing = operational.outgoing();

						operational.copy("evidence", outgoing, "result");
						operational.get("mission").report(outgoing);

						if (reschedule && calls.ticks === 1) {
							operational.get("charter").defer();
						}
					};
				}
			}
		});
	}

	return {
		wiki: wiki,
		platform: platform,
		director: director,
		worker: worker,
		calls: calls,
		runtime: createRuntime(),
		createRuntime: createRuntime,

		start: function () {
			return this.runtime.dispatch(
				director,
				{ type: "test" }
			);
		}
	};
}

function testTickStartsIndependentReportWave(tw) {
	var f = fixture(tw, false);
	var ordered = f.start();

	assert(ordered.status === "completed");
	assert(ordered.flow.errors.length === 0);
	assert(f.calls.ticks === 0);
	assert(f.calls.reports === 0);
	assert(!f.wiki.getTiddler(ordered.obligation));

	var report = f.runtime.runDeferred();

	assert(report.errors.length === 0);
	assert(report.persistent.length === 1);
	assert(report.persistent[0].result.status === "completed");
	assert(report.persistent[0].result.flow.errors.length === 0);
	assert(report.persistentRemaining === 0);
	assert(f.calls.ticks === 1);
	assert(f.calls.reports === 1);
}

function testNewTickWaitsForNextPass(tw) {
	var f = fixture(tw, true);

	f.start();

	var first = f.runtime.runDeferred();

	assert(first.persistent.length === 1);
	assert(first.persistentRemaining === 1);
	assert(f.calls.ticks === 1);
	assert(f.calls.reports === 1);

	var second = f.runtime.runDeferred();

	assert(second.persistent.length === 1);
	assert(second.persistentRemaining === 0);
	assert(f.calls.ticks === 2);
	assert(f.calls.reports === 2);
}

function testPendingTickSurvivesRuntimeReplacement(tw) {
	var f = fixture(tw, false);

	f.start();

	var restarted = f.createRuntime();

	restarted.recover();

	assert(f.calls.ticks === 0);

	var report = restarted.runDeferred();

	assert(report.persistent.length === 1);
	assert(report.persistent[0].result.status === "completed");
	assert(f.calls.ticks === 1);
	assert(f.calls.reports === 1);
}

function testInterruptedTickRecoversWithoutRedispatch(tw) {
	var f = fixture(tw, false);

	f.start();

	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.worker && !injected) {
			injected = true;
			throw new Error("Interrupted runtime tick");
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

	var failed = report.persistent[0].result;

	assert(failed.status === "failed");
	assert(failed.phase === "materialization");
	assert(f.calls.ticks === 1);
	assert(f.calls.reports === 0);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(failed.obligation),
		{ "clerus-custody": f.platform }
	));

	var restarted = f.createRuntime();

	restarted.recover();

	assert(f.calls.ticks === 1);
	assert(f.calls.reports === 0);

	var delivered = restarted.drainFlows();

	assert(delivered.errors.length === 0);
	assert(f.calls.ticks === 1);
	assert(f.calls.reports === 1);
	assert(!f.wiki.getTiddler(failed.obligation));
}

exports.run = function (tw) {
	var cases = [
		["runtime defer: tick starts an independent report wave", testTickStartsIndependentReportWave],
		["runtime defer: a newly requested tick waits", testNewTickWaitsForNextPass],
		["runtime defer: pending tick survives runtime replacement", testPendingTickSurvivesRuntimeReplacement],
		["runtime defer: interrupted tick recovers without redispatch", testInterruptedTickRecoversWithoutRedispatch]
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