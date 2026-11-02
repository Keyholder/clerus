/*\
title: $:/plugins/clerus/core/tests/mission-delivery.js
type: application/javascript
module-type: library
\*/

"use strict";

var Scheduler = require(
	"$:/plugins/clerus/core/scheduler.js"
).Scheduler;

var Store = require("$:/plugins/clerus/core/store.js").Store;

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

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function fixture(tw, handlers) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/";
	var superior = prefix + "delivery-superior";
	var worker = prefix + "delivery-worker";
	var project = "Core2 Mission Delivery Project";

	var root = {
		form: "mission",
		project: project,
		role: [],
		link: "10",
		issued: "1",
		children: { item: "10/1" }
	};

	var child = {
		form: "mission",
		project: project,
		role: ["item"],
		link: "10/1",
		issued: "0",
		children: {}
	};

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
		child: child,
		alias: clone(child),
		subordinate: worker
	});

	write(worker, "worker", {});

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
		scheduler: scheduler,

		registry: function (title) {
			return JSON.parse(wiki.getTiddler(title).fields.text);
		}
	};
}

function testOrderReceptionIsExplicit(tw) {
	var f;

	f = fixture(tw, {
		superior: function (event, operational) {
			var outgoing = operational.outgoing();
			var child = operational.get("child");

			operational.move("child", outgoing, "assignment");

			assert(!operational.keys().includes("child"));
			assert(!operational.keys().includes("alias"));
			assert(outgoing.get("assignment") === child);

			operational.get("subordinate").order(outgoing);
		},

		worker: function (event, operational, incoming) {
			assert(event.type === "order");

			var assignment = incoming.get("assignment");

			// Delivery has not silently filed the document.
			assert(operational.keys().join(",") === "charter");
			assert(assignment.inspect().active);
			assert(assignment.task().value === 42);

			incoming.move("assignment", operational, "mission");

			assert(operational.get("mission") === assignment);
		}
	});

	var result = f.scheduler.dispatch(
		f.superior,
		{ type: "test" }
	);

	assert(result.errors.length === 0);
	assert(result.skipped.length === 0);
	assert(f.registry(f.worker).mission.link === "10/1");
	assert(!f.registry(f.superior).child);
	assert(!f.registry(f.superior).alias);
}

function testAssignmentReturnsThroughItself(tw) {
	var f;
	var returned = false;

	f = fixture(tw, {
		superior: function (event, operational, incoming) {
			if (event.type === "test") {
				var outgoing = operational.outgoing();

				operational.move("child", outgoing, "assignment");
				operational.get("subordinate").order(outgoing);
				return;
			}

			assert(event.type === "report");
			assert(event.role.join("/") === "item");
			assert(!operational.keys().includes("returned"));

			incoming.move("assignment", operational, "returned");
			returned = true;
		},

		worker: function (event, operational, incoming) {
			if (event.type === "order") {
				incoming.move("assignment", operational, "mission");
				return;
			}

			var mission = operational.get("mission");
			var outgoing = operational.outgoing();

			operational.move("mission", outgoing, "assignment");

			// The moved form is still available until sending.
			mission.report(outgoing);
		}
	});

	var first = f.scheduler.dispatch(
		f.superior,
		{ type: "test" }
	);

	assert(first.errors.length === 0);

	var second = f.scheduler.dispatch(
		f.worker,
		{ type: "return" }
	);

	assert(second.errors.length === 0);
	assert(second.skipped.length === 0);
	assert(returned);
	assert(f.registry(f.superior).returned.link === "10/1");
	assert(!f.registry(f.worker).mission);
}

function testOrderMustRetainOperationalParent(tw) {
	var f;
	var refused = false;

	f = fixture(tw, {
		superior: function (event, operational) {
			var outgoing = operational.outgoing();

			operational.move("child", outgoing, "assignment");
			operational.move("root", outgoing, "root");

			throws(function () {
				operational.get("subordinate").order(outgoing);
			}, "retain the parent mission operationally");

			refused = true;

			// Explicitly dispose of the unsent documents.
			outgoing.destroy("assignment");
			outgoing.destroy("root");
		},

		worker: function () {
			throw new Error("Rejected order was delivered");
		}
	});

	var result = f.scheduler.dispatch(
		f.superior,
		{ type: "test" }
	);

	assert(refused);
	assert(result.errors.length === 0);
	assert(result.delivered.length === 1);
}

exports.run = function (tw) {
	var cases = [
		["mission delivery: order reception requires explicit filing", testOrderReceptionIsExplicit],
		["mission delivery: assignment returns through itself", testAssignmentReturnsThroughItself],
		["mission delivery: order retains operational parent", testOrderMustRetainOperationalParent]
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