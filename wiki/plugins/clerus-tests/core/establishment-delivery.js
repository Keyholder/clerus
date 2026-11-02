/*\
title: $:/plugins/clerus/tests/core/establishment-delivery.js
type: application/javascript
module-type: library
\*/

"use strict";

var Scheduler = require(
	"$:/plugins/clerus/core/scheduler.js"
).Scheduler;

var Store = require("$:/plugins/clerus/core/store.js").Store;
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");

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

function fixture(tw, founder, worker, twoContracts) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner =
		"$:/temp/clerus/jobs/" + platform + "/establishment-founder";

	function contract() {
		return {
			form: "contract",
			executor: "worker",
			temp: true,
			book: { instruction: "start" }
		};
	}

	var registry = {
		charter: { form: "charter", status: {} },
		contract: contract(),
		note: { form: "memo", data: { value: 42 } }
	};

	if (twoContracts) {
		registry.secondContract = contract();
	}

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "founder",
		text: JSON.stringify(registry)
	}));

	var sequence = 0;

	var scheduler = new Scheduler({
		platform: platform,

		store: new Store({
			wiki: wiki,
			Tiddler: tw.Tiddler
		}),

		newId: function () {
			sequence++;
			return "establishment-test-" +
				String(sequence).padStart(8, "0");
		},

		readJobs: function () {
			var jobs = [];

			wiki.each(function (tiddler, title) {
				if (!jobTitles.isJobTitle(title)) {
					return;
				}

				jobs.push({
					title: title,
					custody: tiddler.fields["clerus-custody"],
					registry: JSON.parse(tiddler.fields.text)
				});
			});

			return jobs;
		},

		resolveExecutor: function (name) {
			if (name === "founder") {
				return founder;
			}

			if (name === "worker") {
				return worker;
			}
		}
	});

	return {
		wiki: wiki,
		owner: owner,
		scheduler: scheduler,

		childTitle: function () {
			return JSON.parse(
				wiki.getTiddler(owner).fields.text
			).child;
		}
	};
}

function prepareBirth(operational) {
	var child = operational.get("charter").createTitle(
		"worker",
		operational,
		"child"
	);

	var outgoing = operational.outgoing();

	operational.move("contract", outgoing, "contract");
	operational.copy("note", outgoing, "note");

	child.order(outgoing);

	return child;
}

function testExplicitBirthThroughQueue(tw) {
	var trace = [];
	var f;

	f = fixture(tw,
		function (event, operational) {
			trace.push("founder:start");

			prepareBirth(operational);

			assert(!f.wiki.getTiddler(f.childTitle()));

			trace.push("founder:end");
		},
		function (event, operational, incoming) {
			trace.push("worker:start");

			assert(event.type === "order");
			assert(!f.wiki.getTiddler(event.title));
			assert(incoming.get("contract").executor() === "worker");

			var charter = incoming.get("contract").accept(
				"charter",
				{ phase: "starting" }
			);

			assert(f.wiki.getTiddler(event.title));
			assert(operational.keys().join(",") === "charter");

			incoming.move("note", operational, "note");
			charter.setStatus({ phase: "running" });

			trace.push("worker:end");
		}
	);

	var result = f.scheduler.dispatch(
		f.owner,
		{ type: "test" }
	);

	assert(
		trace.join(",") ===
			"founder:start,founder:end,worker:start,worker:end"
	);

	assert(result.errors.length === 0);
	assert(result.skipped.length === 0);
	assert(result.delivered.length === 2);

	var child = f.wiki.getTiddler(f.childTitle());
	var registry = JSON.parse(child.fields.text);

	assert(child.fields["clerus-executor"] === "worker");
	assert(registry.charter.book.instruction === "start");
	assert(registry.charter.status.phase === "running");
	assert(registry.note.data.value === 42);
	assert(f.scheduler.pendingBirths.size === 0);
}

function testPendingBirthCannotBeDuplicated(tw) {
	var births = 0;
	var f;

	f = fixture(tw,
		function (event, operational) {
			var child = prepareBirth(operational);
			var outgoing = operational.outgoing();

			operational.move(
				"secondContract",
				outgoing,
				"contract"
			);

			throws(function () {
				child.order(outgoing);
			}, "pending establishment");

			assert(outgoing.keys().join(",") === "contract");

			outgoing.destroy("contract");
		},
		function (event, operational, incoming) {
			births++;
			incoming.get("contract").accept("charter", {});
			incoming.destroy("note");
		},
		true
	);

	var result = f.scheduler.dispatch(
		f.owner,
		{ type: "test" }
	);

	assert(result.errors.length === 0);
	assert(births === 1);
	assert(f.scheduler.pendingBirths.size === 0);
}

function testFailureBeforeAcceptanceLeavesNoTiddler(tw) {
	var f;

	f = fixture(tw,
		function (event, operational) {
			prepareBirth(operational);
		},
		function () {
			throw new Error("New executor rejected initialization");
		}
	);

	var result = f.scheduler.dispatch(
		f.owner,
		{ type: "test" }
	);

	assert(result.errors.length === 1);
	assert(!f.wiki.getTiddler(f.childTitle()));
	assert(f.scheduler.pendingBirths.size === 0);
}

function testOccupiedTargetIsNotOverwritten(tw) {
	var invoked = false;
	var f;

	f = fixture(tw,
		function (event, operational) {
			prepareBirth(operational);

			f.wiki.addTiddler(new tw.Tiddler({
				title: f.childTitle(),
				text: "intervention"
			}));
		},
		function () {
			invoked = true;
		}
	);

	var result = f.scheduler.dispatch(
		f.owner,
		{ type: "test" }
	);

	assert(!invoked);
	assert(result.errors.length === 0);
	assert(result.skipped.length === 1);
	assert(
		f.wiki.getTiddlerText(f.childTitle()) === "intervention"
	);
	assert(f.scheduler.pendingBirths.size === 0);
}

exports.run = function (tw) {
	var cases = [
		["establishment delivery: explicit acceptance through queue", testExplicitBirthThroughQueue],
		["establishment delivery: pending birth is reserved", testPendingBirthCannotBeDuplicated],
		["establishment delivery: failure before acceptance leaves no job", testFailureBeforeAcceptanceLeavesNoTiddler],
		["establishment delivery: intervention is not overwritten", testOccupiedTargetIsNotOverwritten]
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