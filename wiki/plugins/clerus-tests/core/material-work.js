/*\
title: $:/plugins/clerus/tests/core/material-work.js
type: application/javascript
module-type: library
\*/

"use strict";

var works = require("$:/plugins/clerus/core/work-schema.js");
var perspective = require(
	"$:/plugins/clerus/core/work-perspective.js"
);
var materializer = require(
	"$:/plugins/clerus/core/work-materializer.js"
);
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

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var first = "$:/clerus/jobs/material-work-first";
	var second = "$:/clerus/jobs/material-work-second";
	var target = "Material Work Target";
	var guard = "Material Work Guard";

	function writeJob(title) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "material-work",
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: { phase: "initial" }
				}
			})
		}));
	}

	writeJob(first);
	writeJob(second);

	[target, guard].forEach(function (title) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			"clerus-custody": platform,
			text: "initial"
		}));
	});

	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	function jobTransition(title) {
		var before = store.read(title).fields;
		var after = Object.assign({}, before, {
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: { phase: "completed" }
				}
			})
		});

		return stores.transition(title, before, after);
	}

	var before = store.read(target).fields;

	var work = {
		version: 2,
		id: "material-work-identity-0001",
		checks: [{
			title: guard,
			state: store.read(guard).fields
		}],
		transitions: [
			stores.transition(
				target,
				before,
				Object.assign({}, before, { text: "completed" })
			),
			jobTransition(first),
			jobTransition(second)
		],
		blocks: [],
		emits: []
	};

	function execute(value) {
		return materializer.execute({
			store: store,
			platform: platform,
			work: value || work
		});
	}

	return {
		wiki: wiki,
		store: store,
		platform: platform,
		first: first,
		second: second,
		target: target,
		guard: guard,
		work: work,
		execute: execute
	};
}

function testMultipleJobs(tw) {
	var f = fixture(tw);
	var result = f.execute();

	assert(result.length === 3);
	assert(f.wiki.getTiddlerText(f.target) === "completed");

	[f.first, f.second].forEach(function (title) {
		var registry = JSON.parse(
			f.wiki.getTiddler(title).fields.text
		);

		assert(registry.charter.status.phase === "completed");
	});

	assert(
		f.execute().every(function (result) {
			return result === "already-applied";
		})
	);
}

function testControlConflict(tw) {
	var f = fixture(tw);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.guard),
		{ text: "intervention" }
	));

	throws(function () {
		f.execute();
	}, "Work check conflict");

	assert(f.wiki.getTiddlerText(f.target) === "initial");
}

function testInterruption(tw) {
	var f = fixture(tw);
	var originalApply = f.store.apply;
	var injected = false;

	f.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.target && !injected) {
			injected = true;
			throw new Error("Interrupted after write");
		}

		return result;
	};

	try {
		throws(function () {
			f.execute();
		}, "Interrupted after write");
	} finally {
		f.store.apply = originalApply;
	}

	assert(injected);
	assert(f.wiki.getTiddlerText(f.target) === "completed");

	var restartedStore = new stores.Store({
		wiki: f.wiki,
		Tiddler: tw.Tiddler
	});

	var results = materializer.execute({
		store: restartedStore,
		platform: f.platform,
		work: f.work
	});

	assert(results[0] === "already-applied");
	assert(results[1] === "applied");
	assert(results[2] === "applied");
}

function testWalIsOpaque(tw) {
	var f = fixture(tw);
	var title = "$:/clerus/wal/" + f.platform + "/forbidden";
	var work = works.validate(f.work);

	work.transitions = [
		stores.transition(title, null, {
			title: title,
			"clerus-custody": f.platform,
			text: "{}"
		})
	];

	throws(function () {
		works.validate(work);
	}, "Unsupported material work target");

	work = works.validate(f.work);
	work.checks = [{ title: title, state: null }];

	throws(function () {
		works.validate(work);
	}, "Unsupported material work target");
}

function testRepairDamagedRegistry(tw) {
	var f = fixture(tw);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.first),
		{ text: "{broken" }
	));

	var before = f.store.read(f.first).fields;
	var after = Object.assign({}, before, {
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { repaired: true }
			}
		})
	});

	var work = works.validate(f.work);
	work.transitions = [
		stores.transition(f.first, before, after)
	];

	f.execute(work);

	assert(
		JSON.parse(f.wiki.getTiddlerText(f.first))
			.charter.status.repaired
	);
}

function testPerspective(tw) {
	var f = fixture(tw);
	var view = perspective.evaluate(f.work);

	assert(view.blocks.length === 2);
	assert(view.blocks.indexOf(f.first) !== -1);
	assert(view.blocks.indexOf(f.second) !== -1);
	assert(view.operational.length === 2);
	assert(view.reads.join(",") === f.guard);

	view.blocks.length = 0;

	assert(perspective.evaluate(f.work).blocks.length === 2);

	var other = works.validate(f.work);
	other.id = "material-work-identity-0002";

	assert(perspective.conflicts(f.work, other));
}

function testUnsupportedLifecycleChanges(tw) {
	var f = fixture(tw);
	var work = works.validate(f.work);
	var effect = work.transitions[1];

	effect.after["clerus-custody"] =
		f.platform === "browser" ? "node" : "browser";

	throws(function () {
		works.validate(work);
	}, "relocation protocol");

	work = works.validate(f.work);
	work.transitions[1].after["clerus-executor"] = "replacement";

	throws(function () {
		works.validate(work);
	}, "cannot change job executor");
}

function testOrdinaryCreationAndDeletion(tw) {
	var f = fixture(tw);
	var title = "Material Work Created";
	var work = works.validate(f.work);

	work.checks = [];
	work.transitions = [
		stores.transition(title, null, {
			title: title,
			"clerus-custody": f.platform,
			text: "created"
		})
	];

	f.execute(work);
	assert(f.wiki.getTiddlerText(title) === "created");

	var before = f.store.read(title).fields;
	work.id = "material-work-deletion-0001";
	work.transitions = [
		stores.transition(title, before, null)
	];

	f.execute(work);
	assert(!f.wiki.tiddlerExists(title));
	assert(f.execute(work)[0] === "already-applied");
}

exports.run = function (tw) {
	var cases = [
		["multiple jobs without owner", testMultipleJobs],
		["control conflict prevents writes", testControlConflict],
		["interruption after write is recoverable", testInterruption],
		["WAL is opaque to work", testWalIsOpaque],
		["damaged source registry can be repaired", testRepairDamagedRegistry],
		["perspective is derived and isolated", testPerspective],
		["unsupported lifecycle changes are explicit", testUnsupportedLifecycleChanges],
		["ordinary creation and deletion", testOrdinaryCreationAndDeletion]
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