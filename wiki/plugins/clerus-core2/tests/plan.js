/*\
title: $:/plugins/clerus/core/tests/plan.js
type: application/javascript
module-type: library
\*/

"use strict";

var Plan = require("$:/plugins/clerus/core/plan.js").Plan;
var stores = require("$:/plugins/clerus/core/store.js");

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

function snapshot() {
	return {
		materialized: [{
			title: "Plan Target",
			text: "initial"
		}],
		shadows: []
	};
}

function put(plan, title, text) {
	var before = plan.read(title);

	return plan.apply(stores.transition(
		title,
		before.fields,
		{ title: title, text: text }
	));
}

function remove(plan, title) {
	return plan.apply(stores.transition(
		title,
		plan.read(title).fields,
		null
	));
}

function testIsolatedPerspective() {
	var source = snapshot();
	var plan = new Plan(source);

	put(plan, "Plan Target", "updated");

	assert(plan.read("Plan Target").fields.text === "updated");
	assert(source.materialized[0].text === "initial");

	var view = plan.read("Plan Target");
	view.fields.text = "local";

	assert(plan.read("Plan Target").fields.text === "updated");

	var initial = plan.initial("Plan Target");
	initial.text = "local";

	assert(plan.initial("Plan Target").text === "initial");
}

function testFolding() {
	var plan = new Plan(snapshot());

	put(plan, "Plan Target", "first");
	put(plan, "Plan Target", "second");

	var compiled = plan.export();

	assert(compiled.effects.length === 1);
	assert(compiled.effects[0].before.text === "initial");
	assert(compiled.effects[0].after.text === "second");

	put(plan, "Plan Target", "initial");

	assert(plan.export().effects.length === 0);
}

function testCreationAndDeletionCancel() {
	var plan = new Plan(snapshot());

	put(plan, "Created Target", "created");
	remove(plan, "Created Target");

	assert(plan.read("Created Target").kind === "absent");
	assert(plan.export().effects.length === 0);
}

function testDeletionAndRecreationFold() {
	var plan = new Plan(snapshot());

	remove(plan, "Plan Target");
	put(plan, "Plan Target", "replacement");

	var compiled = plan.export();

	assert(compiled.effects.length === 1);
	assert(compiled.effects[0].before.text === "initial");
	assert(compiled.effects[0].after.text === "replacement");
}

function testConflictIsAtomic() {
	var plan = new Plan(snapshot());
	var before = JSON.stringify(plan.export());

	throws(function () {
		plan.apply(stores.transition(
			"Plan Target",
			{ title: "Plan Target", text: "wrong baseline" },
			{ title: "Plan Target", text: "forbidden" }
		));
	}, "conflict");

	assert(JSON.stringify(plan.export()) === before);
	assert(plan.read("Plan Target").fields.text === "initial");
}

function testSealAndAbort() {
	var plan = new Plan(snapshot());

	put(plan, "Plan Target", "updated");

	var compiled = plan.seal();

	assert(plan.state === "sealed");
	assert(compiled.effects.length === 1);

	compiled.effects[0].after.text = "local";

	assert(plan.export().effects[0].after.text === "updated");

	throws(function () {
		plan.read("Plan Target");
	}, "not open");

	throws(function () {
		plan.seal();
	}, "not open");

	var aborted = new Plan(snapshot());

	put(aborted, "Plan Target", "discarded");
	aborted.abort();

	assert(aborted.state === "aborted");

	throws(function () {
		aborted.export();
	}, "aborted");
}

function testShadowBoundary() {
	var source = snapshot();

	source.shadows.push({
		title: "Shadow Target",
		text: "shadow"
	});

	// Also model a materialized override of a shadow.
	source.shadows.push({
		title: "Plan Target",
		text: "underlying shadow"
	});

	var plan = new Plan(source);

	assert(plan.read("Shadow Target").kind === "shadow");
	assert(plan.read("Plan Target").kind === "materialized");

	throws(function () {
		put(plan, "Shadow Target", "override");
	}, "shadow-backed");

	throws(function () {
		remove(plan, "Plan Target");
	}, "shadow-backed");

	assert(plan.export().effects.length === 0);
}

function testStoreSnapshotIsolation(tw) {
	var wiki = new tw.Wiki();
	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	wiki.addTiddler(new tw.Tiddler({
		title: "Stored Plan Target",
		text: "initial"
	}));

	var plan = new Plan(store.snapshot());

	wiki.addTiddler(new tw.Tiddler({
		title: "Stored Plan Target",
		text: "external change"
	}));

	assert(
		plan.read("Stored Plan Target").fields.text === "initial"
	);

	put(plan, "Stored Plan Target", "proposed");

	assert(
		wiki.getTiddlerText("Stored Plan Target") ===
			"external change"
	);
}

exports.run = function (tw) {
	var cases = [
		["plan: isolated reads and writes", testIsolatedPerspective],
		["plan: repeated changes fold", testFolding],
		["plan: creation and deletion cancel", testCreationAndDeletionCancel],
		["plan: deletion and recreation fold", testDeletionAndRecreationFold],
		["plan: conflict leaves state unchanged", testConflictIsAtomic],
		["plan: seal and abort close access", testSealAndAbort],
		["plan: shadow-backed writes are rejected", testShadowBoundary],
		["plan: store snapshot is independent of later changes", function () {
			testStoreSnapshotIsolation(tw);
		}]
	];

	var results = cases.map(function (item) {
		try {
			item[1]();

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