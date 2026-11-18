/*\
title: $:/plugins/clerus/tests/core/persistent-tick.js
type: application/javascript
module-type: library
\*/

"use strict";

var persistent = require(
	"$:/plugins/clerus/core/persistent-reaction.js"
);
var continuations = require(
	"$:/plugins/clerus/core/continuations.js"
);
var Store = require("$:/plugins/clerus/core/store.js").Store;
var continuationRoot = require(
	"$:/plugins/clerus/tests/continuation-root.js"
);

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

	function execute(handler, continuation) {
		var options = {
			store: store,
			title: owner,
			platform: platform,
			event: { type: "test" },
			handler: handler,
			newId: newId
		};

		if (continuation !== undefined) {
			options.continuation = continuation;
		}

		return persistent.execute(options);
	}

	function pendingTicks() {
		var manager = continuations.create({
			store: store,
			platform: platform,
			newId: newId
		});

		var result = [];

		store.snapshot().materialized.forEach(function (fields) {
			if (
				fields["clerus-wal-kind"] !== "continuation" ||
				fields["clerus-custody"] !== platform
			) {
				return;
			}

			manager.pending(fields.title).forEach(function (entry) {
				if (entry.event.kind === "activation") {
					result.push({
						title: fields.title,
						eventId: entry.id
					});
				}
			});
		});

		return result;
	}

	return {
		wiki: wiki,
		store: store,
		platform: platform,
		owner: owner,
		execute: execute,
		pendingTicks: pendingTicks,

		schedule: function () {
			return continuationRoot.start({
				store: store,
				title: owner,
				platform: platform,
				event: { type: "test" },
				newId: newId,

				handler: function (event, operational) {
					operational.get("charter").defer();
					operational.get("charter").defer();
				}
			});
		},

		manager: function () {
			return continuations.create({
				store: store,
				platform: platform,
				newId: newId
			});
		}
	};
}

function testDeferCreatesContinuationActivation(tw) {
	var f = fixture(tw);
	var scheduled = f.schedule();

	assert(scheduled.status === "completed");
	assert(f.wiki.tiddlerExists(scheduled.obligation));

	var ticks = f.pendingTicks();

	// Repeated defer() calls within one reaction coalesce.
	assert(ticks.length === 1);

	var calls = 0;
	var tick = ticks[0];

	assert(tick.title === scheduled.obligation);

	var completed = f.execute(function (event, operational) {
		calls++;

		assert(event.type === "tick");
		assert(event.id === tick.eventId);

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

	var tick = f.pendingTicks()[0];
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
	assert(body.version === 2);
	assert(body.kind === "continuation");
	assert(body.work === null);
	assert(body.events[tick.eventId].mode === "paused");
	assert(body.events[tick.eventId].event.kind === "activation");
	assert(body.diagnostics.length === 1);
	assert(body.diagnostics[0].event === tick.eventId);
	assert(body.diagnostics[0].error.message === "Tick rejected");
}

function testInterruptedTickDoesNotRepeatHandler(tw) {
	var f = fixture(tw);

	f.schedule();

	var tick = f.pendingTicks()[0];
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
		[
			"persistent tick: deferral creates an activation in its continuation",
			testDeferCreatesContinuationActivation
		],
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