/*\
title: $:/plugins/clerus/core2/tests/reports.js
type: application/javascript
module-type: library
\*/

"use strict";

var Scheduler = require(
	"$:/plugins/clerus/core2/scheduler.js"
).Scheduler;

var Store = require("$:/plugins/clerus/core2/store.js").Store;

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function throws(fn, fragment) {
	var caught;

	try {
		fn();
	} catch (error) {
		caught = error;
	}

	assert(caught, "Expected an exception");

	if (fragment) {
		assert(
			String(caught.message).indexOf(fragment) !== -1,
			"Unexpected exception: " + caught.message
		);
	}
}

function fixture(tw, handlers, sameHolder) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/";
	var superior = prefix + "report-superior";
	var worker = prefix + "report-worker";
	var project = "Core2 Report Project";

	function grant(role, link, children) {
		return {
			form: "mission",
			project: project,
			role: role,
			link: link,
			issued: "0",
			children: children || {}
		};
	}

	var root = grant([], "10", { item: "10/1" });
	var child = grant(["item"], "10/1");

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

	write(superior, "superior", {
		root: root,
		subordinate: worker
	});

	var workerRegistry = {
		mission: child,
		evidence: { form: "memo", data: { value: 42 } }
	};

	if (sameHolder) {
		workerRegistry.root = root;

		var superiorRegistry = JSON.parse(
			wiki.getTiddler(superior).fields.text
		);

		delete superiorRegistry.root;

		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(superior),
			{ text: JSON.stringify(superiorRegistry) }
		));
	}

	write(worker, "worker", workerRegistry);

	var scheduler = new Scheduler({
		platform: platform,

		store: new Store({
			wiki: wiki,
			Tiddler: tw.Tiddler
		}),

		readJobs: function () {
			return [superior, worker].map(function (title) {
				var tiddler = wiki.getTiddler(title);

				return {
					title: title,
					custody: tiddler.fields["clerus-custody"],
					registry: JSON.parse(tiddler.fields.text)
				};
			});
		},

		resolveExecutor: function (name) {
			return handlers[name];
		}
	});

	return {
		wiki: wiki,
		superior: superior,
		worker: worker,
		project: project,
		scheduler: scheduler
	};
}

function testReportThenOrder(tw) {
	var trace = [];
	var f;

	f = fixture(tw, {
		worker: function (event, operational, incoming) {
			if (event.type === "test") {
				trace.push("worker:report");

				var outgoing = operational.outgoing();

				operational.copy("evidence", outgoing, "result");
				operational.get("mission").report(outgoing);

				assert(operational.get("mission").inspect().active);
				return;
			}

			assert(event.type === "order");
			trace.push("worker:order");

			assert(incoming.get("answer").data().value === 42);
			incoming.destroy("answer");
		},

		superior: function (event, operational, incoming) {
			trace.push("superior:report");

			assert(event.type === "report");
			assert(event.project === f.project);
			assert(event.role.join("/") === "item");
			assert(!("source" in event));

			var outgoing = incoming.outgoing();

			incoming.move("result", outgoing, "answer");
			operational.get("subordinate").order(outgoing);
		}
	});

	var result = f.scheduler.dispatch(
		f.worker,
		{ type: "test" }
	);

	assert(
		trace.join(",") ===
			"worker:report,superior:report,worker:order"
	);

	assert(result.errors.length === 0);
	assert(result.skipped.length === 0);
	assert(result.delivered.length === 3);
}

function testOrderCannotProduceReport(tw) {
	var refused = false;

	var f = fixture(tw, {
		superior: function () {},

		worker: function (event, operational) {
			var outgoing = operational.outgoing();

			operational.copy("evidence", outgoing, "result");

			throws(function () {
				operational.get("mission").report(outgoing);
			}, "Cannot report while reacting to an order");

			assert(outgoing.keys().join(",") === "result");
			refused = true;

			// Explicitly discard the unsent copy.
			outgoing.destroy("result");
		}
	});

	var result = f.scheduler.dispatch(
		f.worker,
		{ type: "order" }
	);

	assert(refused);
	assert(result.errors.length === 0);
	assert(result.delivered.length === 1);
}

function testSameHolderParentIsRejected(tw) {
	var refused = false;

	var f = fixture(tw, {
		superior: function () {},

		worker: function (event, operational) {
			var outgoing = operational.outgoing();

			throws(function () {
				operational.get("mission").report(outgoing);
			}, "distinct parent holder");

			refused = true;
		}
	}, true);

	var result = f.scheduler.dispatch(
		f.worker,
		{ type: "test" }
	);

	assert(refused);
	assert(result.errors.length === 0);
	assert(result.delivered.length === 1);
}

exports.run = function (tw) {
	var cases = [
		["reports: report and reply complete in one pass", testReportThenOrder],
		["reports: order reaction cannot report", testOrderCannotProduceReport],
		["reports: parent holder must be distinct", testSameHolderParentIsRejected]
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