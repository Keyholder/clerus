/*\
title: $:/plugins/clerus/core2/tests/scheduler-lifecycle.js
type: application/javascript
module-type: library
\*/

"use strict";

var Scheduler = require(
	"$:/plugins/clerus/core2/scheduler.js"
).Scheduler;

var Store = require("$:/plugins/clerus/core2/store.js").Store;
var lifecycle = require("$:/plugins/clerus/core2/lifecycle.js");
var missions = require("$:/plugins/clerus/core2/missions.js");

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

function fixture(tw, handlers) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/";
	var owner = prefix + "lifecycle-owner";
	var child = prefix + "lifecycle-child";
	var incidents = [];

	function write(title, executor, registry) {
		registry.charter = {
			form: "charter",
			status: { phase: "working" }
		};

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(registry)
		}));
	}

	write(owner, "owner", {
		child: child,
		note: { form: "memo", data: { action: "stop" } },
		mission: {
			form: "mission",
			project: "Scheduler Lifecycle Project",
			role: [],
			link: "10",
			issued: "1",
			children: { item: "10/1" }
		}
	});

	write(child, "child", {
		mission: {
			form: "mission",
			project: "Scheduler Lifecycle Project",
			role: ["item"],
			link: "10/1",
			issued: "0",
			children: {}
		}
	});

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	function readJobs() {
		return [owner, child].map(function (title) {
			var current = wiki.getTiddler(title);

			return {
				title: title,
				custody: current.fields["clerus-custody"],
				registry: JSON.parse(current.fields.text)
			};
		});
	}

	var scheduler = new Scheduler({
		store: store,
		platform: platform,
		readJobs: readJobs,

		resolveExecutor: function (name) {
			return handlers[name];
		},

		lifecycle: lifecycle.create({
			store: store,
			platform: platform,

			recordIncident: function (incident) {
				incidents.push(incident);
				return "$:/test/scheduler-incidents/" + incidents.length;
			}
		})
	});

	return {
		wiki: wiki,
		owner: owner,
		child: child,
		scheduler: scheduler,
		incidents: incidents,

		active: function () {
			return missions.evaluate(readJobs()).active;
		}
	};
}

function testDismissedReactionCanSend(tw) {
	var trace = [];
	var f;

	f = fixture(tw, {
		owner: function (event, operational) {
			if (event.type === "test") {
				trace.push("failure");
				throw new Error("Executor failure");
			}

			assert(event.type === "dismissed");
			trace.push("dismissed");

			assert(f.active().length === 0);

			throws(function () {
				operational.get("charter").setStatus({});
			}, "not writable");

			var outgoing = operational.outgoing();

			operational.copy("note", outgoing, "instruction");
			operational.get("child").order(outgoing);
		},

		child: function (event, operational, incoming) {
			trace.push("child");

			assert(event.type === "order");
			assert(incoming.get("instruction").data().action === "stop");

			incoming.destroy("instruction");
		}
	});

	var ownerBefore = f.wiki.getTiddler(f.owner).fields.text;
	var childBefore = f.wiki.getTiddler(f.child).fields.text;

	var result = f.scheduler.dispatch(
		f.owner,
		{ type: "test" }
	);

	assert(trace.join(",") === "failure,dismissed,child");
	assert(result.errors.length === 1);
	assert(result.errors[0].lifecycle.dismissed);
	assert(f.incidents.length === 1);

	assert(
		f.wiki.getTiddler(f.owner).fields["clerus-custody"] === "user"
	);

	assert(f.wiki.getTiddler(f.owner).fields.text === ownerBefore);
	assert(f.wiki.getTiddler(f.child).fields.text === childBefore);
}

function testDismissalFailureIsIgnored(tw) {
	var notifications = 0;

	var f = fixture(tw, {
		owner: function (event) {
			if (event.type === "dismissed") {
				notifications++;
				throw new Error("Failure during dismissal notification");
			}

			throw new Error("Initial failure");
		},

		child: function () {}
	});

	var first = f.scheduler.dispatch(
		f.owner,
		{ type: "test" }
	);

	assert(notifications === 1);
	assert(first.errors.length === 1);
	assert(f.incidents.length === 1);

	// A later restricted reaction must not start another error cycle.
	var second = f.scheduler.dispatch(
		f.owner,
		{ type: "restricted-test" }
	);

	assert(second.errors.length === 0);
	assert(notifications === 1);
	assert(f.incidents.length === 1);
}

function testMaterializationFailureDoesNotDismiss(tw) {
	var dismissed = 0;

	var f = fixture(tw, {
		owner: function (event, operational) {
			if (event.type === "dismissed") {
				dismissed++;
				return;
			}

			operational.get("charter").setStatus({
				phase: "updated"
			});
		},

		child: function () {}
	});

	var before = f.wiki.getTiddler(f.owner);
	var originalAdd = f.wiki.addTiddler.bind(f.wiki);

	f.wiki.addTiddler = function (tiddler) {
		if (tiddler.fields.title === f.owner) {
			throw new Error("Injected storage failure");
		}

		return originalAdd(tiddler);
	};

	var result;

	try {
		result = f.scheduler.dispatch(
			f.owner,
			{ type: "test" }
		);
	} finally {
		f.wiki.addTiddler = originalAdd;
	}

	assert(result.errors.length === 1);
	assert(result.errors[0].phase === "materialization");
	assert(!result.errors[0].lifecycle);
	assert(f.incidents.length === 0);
	assert(dismissed === 0);

	assert(
		f.wiki.getTiddler(f.owner).fields["clerus-custody"] ===
			before.fields["clerus-custody"]
	);
}

exports.run = function (tw) {
	var cases = [
		["scheduler lifecycle: dismissed reaction can send orders", testDismissedReactionCanSend],
		["scheduler lifecycle: repeated restricted errors are ignored", testDismissalFailureIsIgnored],
		["scheduler lifecycle: storage failure does not dismiss executor", testMaterializationFailureDoesNotDismiss]
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