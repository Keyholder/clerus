/*\
title: $:/plugins/clerus/tests/core/continuation-mixed.js
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

function environment(tw, handlers) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var sequence = 0;

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		newId: function () {
			sequence++;

			return "mixed-v2-generated-" +
				String(sequence).padStart(12, "0");
		},
		resolveExecutor: function (name) {
			return handlers[name];
		}
	});

	function write(title, executor, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(Object.assign({
				charter: {
					form: "charter",
					status: {}
				}
			}, registry || {}))
		}));
	}

	function publish(event) {
		var title = runtime.continuations.accept({
			version: 2,
			id: runtime.newId(),
			checks: [],
			transitions: [],
			blocks: [],
			emits: [{
				id: runtime.newId(),
				event: event
			}]
		});

		runtime.recover();
		return title;
	}

	return {
		wiki: wiki,
		platform: platform,
		runtime: runtime,
		write: write,
		publish: publish,

		registry: function (title) {
			return JSON.parse(wiki.getTiddlerText(title));
		}
	};
}

function assertNoContinuationErrors(report) {
	assert(report.errors.length === 0);

	report.continuations.forEach(function (pass) {
		assert(pass.errors.length === 0);
	});
}

function testPersistentForwardsToEphemeral(tw) {
	var handlers = {};
	var trace = [];
	var f = environment(tw, handlers);

	var manager = "$:/clerus/jobs/mixed-v2-manager";
	var worker =
		"$:/temp/clerus/jobs/" + f.platform + "/mixed-v2-worker";

	f.write(manager, "manager", {
		worker: worker
	});
	f.write(worker, "worker");

	handlers.manager = function (event, operational, incoming) {
		trace.push("manager");
		assert(event.type === "order");

		var outgoing = incoming.outgoing();

		incoming.move("input", outgoing, "input");
		operational.get("worker").order(outgoing);
	};

	handlers.worker = function (event, operational, incoming) {
		trace.push("worker");
		assert(event.type === "order");

		incoming.move("input", operational, "received");
	};

	var journal = f.publish({
		kind: "delivery",
		recipient: {
			title: manager,
			executor: "manager"
		},
		type: "order",
		registry: {
			input: {
				form: "memo",
				data: 42
			}
		}
	});

	var report = f.runtime.drainFlows();

	assertNoContinuationErrors(report);
	assert(trace.join(",") === "manager,worker");
	assert(f.registry(worker).received.data === 42);
	assert(!f.wiki.tiddlerExists(journal));

	var completed = [];

	report.continuations.forEach(function (pass) {
		completed = completed.concat(pass.completed);
	});

	assert(completed.length === 2);

	completed.forEach(function (entry) {
		assert(entry.title === journal);
	});

	f.runtime.drainFlows();
	assert(trace.join(",") === "manager,worker");
}

function reportingFixture(tw, deferReport) {
	var handlers = {};
	var trace = [];
	var f = environment(tw, handlers);

	var director = "$:/clerus/jobs/mixed-v2-director";
	var manager =
		"$:/temp/clerus/jobs/" + f.platform + "/mixed-v2-reporter";
	var project = "Mixed V2 Reporting Project";

	f.write(director, "director", {
		manager: manager,
		mission: {
			form: "mission",
			project: project,
			role: [],
			link: "10",
			issued: "1",
			children: {
				department: "10/1"
			}
		}
	});

	f.write(manager, "manager", {
		mission: {
			form: "mission",
			project: project,
			role: ["department"],
			link: "10/1",
			issued: "0",
			children: {}
		}
	});

	f.wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		text: JSON.stringify({
			task: {},
			parts: {
				department: {
					task: {},
					parts: {
						leaf: {
							task: {},
							parts: {}
						}
					}
				}
			}
		})
	}));

	handlers.director = function (event, operational, incoming) {
		trace.push("director:report");

		assert(event.type === "report");
		assert(event.project === project);
		assert(event.role.join("/") === "department");
		assert(!("source" in event));

		incoming.move("result", operational, "received");
	};

	handlers.manager = function (event, operational, incoming) {
		if (deferReport && event.type === "order") {
			trace.push("manager:order");

			incoming.move("input", operational, "evidence");
			operational.get("charter").defer();
			return;
		}

		if (deferReport) {
			assert(event.type === "tick");
			trace.push("manager:tick");

			var report = operational.outgoing();

			operational.move("evidence", report, "result");
			operational.get("mission").report(report);
			return;
		}

		assert(event.type === "report");
		assert(event.role.join("/") === "department/leaf");

		trace.push("manager:report");

		var outgoing = incoming.outgoing();

		incoming.move("input", outgoing, "result");
		operational.get("mission").report(outgoing);
	};

	var event = {
		kind: "delivery",
		recipient: {
			title: manager,
			executor: "manager"
		},
		type: deferReport ? "order" : "report",
		registry: {
			input: {
				form: "memo",
				data: 42
			}
		}
	};

	if (!deferReport) {
		event.project = project;
		event.role = ["department", "leaf"];
	}

	return {
		f: f,
		trace: trace,
		director: director,
		manager: manager,
		journal: f.publish(event)
	};
}

function testEphemeralReportReachesPersistentSuperior(tw) {
	var setup = reportingFixture(tw, false);
	var f = setup.f;

	var report = f.runtime.drainFlows();

	assertNoContinuationErrors(report);

	assert(
		setup.trace.join(",") ===
			"manager:report,director:report"
	);

	assert(f.registry(setup.director).received.data === 42);
	assert(!f.wiki.tiddlerExists(setup.journal));
	assert(report.ephemeralRemaining === 0);
	assert(report.remaining === 0);

	f.runtime.drainFlows();

	assert(
		setup.trace.join(",") ===
			"manager:report,director:report"
	);
}

function testEphemeralOrderDefersReportToNewWave(tw) {
	var setup = reportingFixture(tw, true);
	var f = setup.f;

	var first = f.runtime.drainFlows();

	assertNoContinuationErrors(first);
	assert(setup.trace.join(",") === "manager:order");
	assert(!f.registry(setup.director).received);

	/*
		The delivery is acknowledged. Its deferred ephemeral work
		is runtime-local and is not an unconsumed v2 event.
	*/
	assert(!f.wiki.tiddlerExists(setup.journal));

	var deferred = f.runtime.runDeferred();

	assert(deferred.errors.length === 0);

	assert(
		setup.trace.join(",") ===
			"manager:order,manager:tick,director:report"
	);

	assert(f.registry(setup.director).received.data === 42);
	assert(!f.registry(setup.manager).evidence);

	f.runtime.runDeferred();

	assert(
		setup.trace.join(",") ===
			"manager:order,manager:tick,director:report"
	);
}

exports.run = function (tw) {
	var cases = [
		["persistent recipient forwards to ephemeral within v2", testPersistentForwardsToEphemeral],
		["ephemeral report enters persistent superior", testEphemeralReportReachesPersistentSuperior],
		["ephemeral order reports only through a later tick", testEphemeralOrderDefersReportToNewWave]
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