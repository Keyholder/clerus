/*\
title: $:/plugins/clerus/core2/tests/ephemeral-defer.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core2/runtime.js").Runtime;

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw, workerHandler) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var director = "$:/clerus/jobs/defer-director";
	var worker =
		"$:/temp/clerus/jobs/" + platform + "/defer-worker";
	var project = "Core2 Deferred Project";
	var sequence = 0;
	var trace = [];

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

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "ephemeral-defer-" +
				String(sequence).padStart(12, "0");
		},

		resolveExecutor: function (name) {
			if (name === "worker") {
				return workerHandler;
			}

			if (name === "director") {
				return function (event, operational, incoming) {
					if (event.type === "report") {
						trace.push("report");
						incoming.destroy("result");
						return;
					}

					var outgoing = operational.outgoing();

					operational.copy("note", outgoing, "instruction");
					operational.get("worker").order(outgoing);
				};
			}
		}
	});

	return {
		wiki: wiki,
		director: director,
		worker: worker,
		runtime: runtime,
		trace: trace
	};
}

function testOrderDefersIndependentReport(tw) {
	var f;

	f = fixture(tw, function (event, operational, incoming) {
		if (event.type === "order") {
			f.trace.push("order");
			incoming.destroy("instruction");

			operational.get("charter").defer();
			operational.get("charter").defer();
			return;
		}

		assert(event.type === "tick");
		assert(event.id);

		f.trace.push("tick");

		var outgoing = operational.outgoing();

		operational.copy("evidence", outgoing, "result");
		operational.get("mission").report(outgoing);
	});

	var ordered = f.runtime.dispatch(
		f.director,
		{ type: "test" }
	);

	assert(ordered.flow.errors.length === 0);
	assert(f.trace.join(",") === "order");
	assert(f.runtime.deferred.inspect().length === 1);

	var ticked = f.runtime.runDeferred();

	assert(ticked.delivered.length === 1);
	assert(ticked.errors.length === 0);
	assert(ticked.remaining === 0);
	assert(f.trace.join(",") === "order,tick,report");

	var pass = ticked.delivered[0].result;

	assert(pass.errors.length === 0);
	assert(pass.persistent.length === 1);
	assert(pass.persistent[0].result.status === "completed");
}

function testTickCanRequestOnlyNextPass(tw) {
	var ticks = 0;
	var f;

	f = fixture(tw, function (event, operational) {
		if (event.type === "start") {
			operational.get("charter").defer();
			return;
		}

		assert(event.type === "tick");
		ticks++;

		if (ticks === 1) {
			operational.get("charter").defer();
		}
	});

	f.runtime.dispatch(f.worker, { type: "start" });

	var first = f.runtime.runDeferred();

	assert(ticks === 1);
	assert(first.delivered.length === 1);
	assert(first.remaining === 1);

	var second = f.runtime.runDeferred();

	assert(ticks === 2);
	assert(second.delivered.length === 1);
	assert(second.remaining === 0);
}

function testExecutorReplacementDropsOldTick(tw) {
	var ticks = 0;

	var f = fixture(tw, function (event, operational) {
		if (event.type === "start") {
			operational.get("charter").defer();
			return;
		}

		ticks++;
	});

	f.runtime.dispatch(f.worker, { type: "start" });

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.worker),
		{ "clerus-executor": "replacement" }
	));

	var report = f.runtime.runDeferred();

	assert(report.skipped.length === 1);
	assert(report.remaining === 0);
	assert(ticks === 0);
}

exports.run = function (tw) {
	var cases = [
		["ephemeral defer: order ends before an independent report wave", testOrderDefersIndependentReport],
		["ephemeral defer: a tick schedules only a later pass", testTickCanRequestOnlyNextPass],
		["ephemeral defer: executor replacement drops the old request", testExecutorReplacementDropsOldTick]
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