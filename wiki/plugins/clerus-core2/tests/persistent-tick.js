/*\
title: $:/plugins/clerus/core2/tests/persistent-tick.js
type: application/javascript
module-type: library
\*/

"use strict";

var persistent = require(
	"$:/plugins/clerus/core2/persistent-reaction.js"
);
var flows = require(
	"$:/plugins/clerus/core2/flow-obligations.js"
);
var Store = require("$:/plugins/clerus/core2/store.js").Store;

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/persistent-tick-owner";
	var sequence = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "owner",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			}
		})
	}));

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	function newId() {
		sequence++;

		return "persistent-tick-" +
			String(sequence).padStart(12, "0");
	}

	function execute(handler, deferred) {
		return persistent.execute({
			store: store,
			title: owner,
			platform: platform,
			event: { type: "test" },
			handler: handler,
			newId: newId,
			deferred: deferred
		});
	}

	function pendingTicks() {
		return store.snapshot().materialized.filter(function (fields) {
			return fields["clerus-wal-kind"] === "deferred";
		});
	}

	return {
		wiki: wiki,
		store: store,
		platform: platform,
		owner: owner,
		execute: execute,
		pendingTicks: pendingTicks,

		schedule: function () {
			return execute(function (event, operational) {
				operational.get("charter").defer();
				operational.get("charter").defer();
			});
		},

		manager: function () {
			return flows.create({
				store: store,
				platform: platform,
				newId: newId
			});
		}
	};
}

function address(fields) {
	var body = JSON.parse(fields.text);

	return {
		title: fields.title,
		id: body.effect.id
	};
}

function testDeferCreatesIndependentObligation(tw) {
	var f = fixture(tw);
	var scheduled = f.schedule();

	assert(scheduled.status === "completed");
	assert(!f.wiki.getTiddler(scheduled.obligation));

	var ticks = f.pendingTicks();

	assert(ticks.length === 1);

	var calls = 0;
	var tick = address(ticks[0]);

	var completed = f.execute(function (event, operational) {
		calls++;

		assert(event.type === "tick");
		assert(event.id === tick.id);

		operational.get("charter").setStatus({
			phase: "ticked"
		});
	}, tick);

	assert(completed.status === "completed");
	assert(completed.obligation === tick.title);
	assert(calls === 1);
	assert(!f.wiki.getTiddler(tick.title));
}

function testFailedTickPreservesEvidence(tw) {
	var f = fixture(tw);

	f.schedule();

	var tick = address(f.pendingTicks()[0]);
	var before = f.wiki.getTiddler(f.owner).fields.text;

	var failed = f.execute(function (event, operational) {
		operational.get("charter").setStatus({
			phase: "discarded"
		});

		throw new Error("Tick rejected");
	}, tick);

	assert(failed.status === "failed");
	assert(failed.phase === "reaction");
	assert(f.wiki.getTiddler(f.owner).fields.text === before);

	var journal = f.wiki.getTiddler(tick.title);
	var body = JSON.parse(journal.fields.text);

	assert(journal.fields["clerus-custody"] === "user");
	assert(body.errors[0].event.id === tick.id);
	assert(body.errors[0].error.message === "Tick rejected");
}

function testInterruptedTickDoesNotRepeatHandler(tw) {
	var f = fixture(tw);

	f.schedule();

	var tick = address(f.pendingTicks()[0]);
	var originalApply = f.store.apply;
	var injected = false;
	var calls = 0;

	f.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.owner && !injected) {
			injected = true;
			throw new Error("Interrupted tick write");
		}

		return result;
	};

	var failed;

	try {
		failed = f.execute(function (event, operational) {
			calls++;

			operational.get("charter").setStatus({
				phase: "ticked"
			});
		}, tick);
	} finally {
		f.store.apply = originalApply;
	}

	assert(failed.status === "failed");
	assert(failed.phase === "materialization");
	assert(calls === 1);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(tick.title),
		{ "clerus-custody": f.platform }
	));

	f.manager().resume(tick.title);

	assert(calls === 1);
	assert(!f.wiki.getTiddler(tick.title));
}

function testRejectedReactionDoesNotScheduleTick(tw) {
	var f = fixture(tw);

	var failed = f.execute(function (event, operational) {
		operational.get("charter").defer();
		throw new Error("Rejected deferral");
	});

	assert(failed.status === "failed");
	assert(failed.phase === "reaction");
	assert(f.pendingTicks().length === 0);
}

exports.run = function (tw) {
	var cases = [
		["persistent tick: deferral creates an independent obligation", testDeferCreatesIndependentObligation],
		["persistent tick: failed reaction preserves event evidence", testFailedTickPreservesEvidence],
		["persistent tick: recovery does not repeat handler", testInterruptedTickDoesNotRepeatHandler],
		["persistent tick: rejected reaction schedules nothing", testRejectedReactionDoesNotScheduleTick]
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