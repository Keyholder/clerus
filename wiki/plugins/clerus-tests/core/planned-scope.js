/*\
title: $:/plugins/clerus/tests/core/planned-scope.js
type: application/javascript
module-type: library
\*/

"use strict";

var Plan = require("$:/plugins/clerus/core/plan.js").Plan;
var stores = require("$:/plugins/clerus/core/store.js");
var plannedScopes = require(
	"$:/plugins/clerus/core/planned-scope.js"
);

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

function fixture(tw, custody) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/planned-scope-owner";

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": custody || platform,
		"clerus-executor": "planned-scope",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			note: {
				form: "memo",
				data: { value: 1 }
			}
		})
	}));

	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var plan = new Plan(store.snapshot());

	var scope = plannedScopes.open({
		plan: plan,
		title: title,
		platform: platform,
		eventType: "test",

		incoming: {
			input: {
				form: "memo",
				data: { value: 42 }
			}
		}
	});

	return {
		wiki: wiki,
		title: title,
		plan: plan,
		scope: scope,

		plannedRegistry: function () {
			return JSON.parse(plan.read(title).fields.text);
		}
	};
}

function testWritesArePlanned(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.title).fields.text;

	try {
		var note = f.scope.operational.get("note");

		note.setData({ value: 2 });

		f.scope.operational.get("charter").setStatus({
			phase: "proposed"
		});

		assert(note.data().value === 2);
		assert(f.plannedRegistry().note.data.value === 2);
		assert(
			f.plannedRegistry().charter.status.phase === "proposed"
		);

		assert(f.wiki.getTiddler(f.title).fields.text === before);
		assert(f.plan.export().effects.length === 1);
	} finally {
		f.scope.close();
		f.plan.abort();
	}
}

function testExplicitInputPlacement(tw) {
	var f = fixture(tw);

	try {
		var incoming = f.scope.incoming.get("input");

		f.scope.incoming.move(
			"input",
			f.scope.operational,
			"received"
		);

		assert(f.scope.operational.get("received") === incoming);
		assert(f.plannedRegistry().received.data.value === 42);
		f.scope.assertResolved();

		var stored = JSON.parse(
			f.wiki.getTiddler(f.title).fields.text
		);

		assert(!stored.received);
	} finally {
		f.scope.close();
		f.plan.abort();
	}
}

function testDeniedWriteLeavesPlanAndScopeUnchanged(tw) {
	var f = fixture(tw, "user");

	try {
		var before = JSON.stringify(f.scope.snapshot());

		throws(function () {
			f.scope.operational.get("note").setData({
				value: 99
			});
		}, "not writable");

		assert(JSON.stringify(f.scope.snapshot()) === before);
		assert(f.plan.export().effects.length === 0);

		var outgoing = f.scope.incoming.outgoing();

		f.scope.incoming.get("input").setData({ value: 43 });
		f.scope.incoming.move("input", outgoing, "result");

		assert(outgoing.get("result").data().value === 43);
		assert(f.plan.export().effects.length === 0);
		f.scope.assertResolved();
	} finally {
		f.scope.close();
		f.plan.abort();
	}
}

function testReversibleFailureLeavesScopeOpen(tw) {
	var f = fixture(tw);
	var originalApply = f.plan.apply;
	var originalFork = f.plan.fork;

	/*
		Inject a failure after a branch accepted its local write,
		but before the branch can be published into the root plan.
	*/
	f.plan.fork = function () {
		var branch = originalFork.call(this);

		branch.apply = function (effect) {
			originalApply.call(this, effect);
			throw new Error("Injected reversible failure");
		};

		return branch;
	};

	try {
		var note = f.scope.operational.get("note");

		throws(function () {
			note.setData({ value: 2 });
		}, "Injected reversible failure");

		assert(note.data().value === 1);
		assert(f.plannedRegistry().note.data.value === 1);
		assert(f.plan.export().effects.length === 0);

		f.plan.fork = originalFork;

		note.setData({ value: 3 });

		assert(note.data().value === 3);
		assert(f.plannedRegistry().note.data.value === 3);
	} finally {
		f.plan.fork = originalFork;
		f.scope.close();
		f.plan.abort();
	}
}

exports.run = function (tw) {
	var cases = [
		["planned scope: writes remain isolated", testWritesArePlanned],
		["planned scope: input placement is explicit and virtual", testExplicitInputPlacement],
		["planned scope: denied write preserves both states", testDeniedWriteLeavesPlanAndScopeUnchanged],
		["planned scope: reversible failure permits continued work", testReversibleFailureLeavesScopeOpen]
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