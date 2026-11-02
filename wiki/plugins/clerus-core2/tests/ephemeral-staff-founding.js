/*\
title: $:/plugins/clerus/core2/tests/ephemeral-staff-founding.js
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
	assert(founded.flow.errors.length === 0);
	assert(founded.flow.completed.length === 1);
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

	assert(result.flow.errors.length === 1);
	assert(result.flow.errors[0].result.lifecycle.dismissed);
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
	assert(JSON.parse(journal.fields.text).errors.length === 1);
}

exports.run = function (tw) {
	var cases = [
		["ephemeral staff founding: persistent founder receives worker report", testFoundingAndReport],
		["ephemeral staff founding: failed initializer preserves documents", testFailedInitializationPreservesDocuments]
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