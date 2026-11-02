/*\
title: $:/plugins/clerus/core2/tests/deferred-resolution.js
type: application/javascript
module-type: library
\*/

"use strict";

var deferred = require(
	"$:/plugins/clerus/core2/deferred-obligations.js"
);
var flows = require(
	"$:/plugins/clerus/core2/flow-obligations.js"
);
var planned = require(
	"$:/plugins/clerus/core2/planned-reaction.js"
);
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

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/deferred-resolution-owner";

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

	var effect = {
		version: 1,
		kind: "deferred-event",
		id: "deferred-resolution-event-0001",
		platform: platform,
		recipient: {
			title: owner,
			executor: "owner"
		}
	};

	var manager = deferred.create({
		store: store,
		platform: platform
	});

	var title = manager.record(effect);
	var calls = 0;

	var flowManager = flows.create({
		store: store,
		platform: platform,
		newId: function () {
			return "unused-resolution-flow-identity";
		}
	});

	return {
		wiki: wiki,
		store: store,
		platform: platform,
		owner: owner,
		effect: effect,
		title: title,
		manager: manager,
		flows: flowManager,

		proposal: function () {
			return planned.execute({
				store: store,
				title: owner,
				platform: platform,

				event: {
					type: "tick",
					id: effect.id
				},

				handler: function (event, operational) {
					calls++;

					operational.get("charter").setStatus({
						phase: "completed"
					});
				}
			});
		},

		calls: function () {
			return calls;
		},

		phase: function () {
			return JSON.parse(
				wiki.getTiddler(owner).fields.text
			).charter.status.phase;
		}
	};
}

function testTickBecomesAcceptedPlan(tw) {
	var f = fixture(tw);

	var proposal = f.proposal();

	f.manager.accept(f.title, f.effect.id, proposal);

	assert(f.calls() === 1);
	assert(f.phase() === "initial");

	var current = f.wiki.getTiddler(f.title);

	assert(current.fields["clerus-wal-kind"] === "flow");
	assert(current.fields["clerus-deferred-effect"]);

	// Parent replay still recognizes the registration.
	assert(f.manager.record(f.effect) === f.title);

	f.flows.resume(f.title);

	assert(f.calls() === 1);
	assert(f.phase() === "completed");
	assert(!f.wiki.getTiddler(f.title));
}

function testFailureIsHistoricalWithoutOwnerChanges(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.owner).fields.text;

	f.manager.fail(
		f.title,
		f.effect.id,
		f.effect.recipient,
		new Error("Tick failed")
	);

	var journal = f.wiki.getTiddler(f.title);
	var record = JSON.parse(journal.fields.text);

	assert(journal.fields["clerus-custody"] === "user");
	assert(journal.fields["clerus-wal-kind"] === "flow");
	assert(record.active === null);
	assert(record.pending.length === 0);
	assert(record.errors[0].event.type === "tick");
	assert(record.errors[0].event.id === f.effect.id);
	assert(record.errors[0].error.message === "Tick failed");

	assert(f.wiki.getTiddler(f.owner).fields.text === before);
	assert(f.manager.record(f.effect) === f.title);

	// Re-registration must not reclaim user custody.
	assert(
		f.wiki.getTiddler(f.title)
			.fields["clerus-custody"] === "user"
	);
}

function testInterruptedMaterializationDoesNotRepeatTick(tw) {
	var f = fixture(tw);

	f.manager.accept(
		f.title,
		f.effect.id,
		f.proposal()
	);

	var originalApply = f.store.apply;
	var injected = false;

	f.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.owner && !injected) {
			injected = true;
			throw new Error("Interrupted tick materialization");
		}

		return result;
	};

	try {
		throws(function () {
			f.flows.resume(f.title);
		}, "Interrupted tick materialization");
	} finally {
		f.store.apply = originalApply;
	}

	assert(f.calls() === 1);
	assert(f.phase() === "completed");

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.title),
		{ "clerus-custody": f.platform }
	));

	f.flows.resume(f.title);

	assert(f.calls() === 1);
	assert(!f.wiki.getTiddler(f.title));
}

exports.run = function (tw) {
	var cases = [
		["deferred resolution: tick becomes an accepted flow plan", testTickBecomesAcceptedPlan],
		["deferred resolution: failed tick preserves historical evidence", testFailureIsHistoricalWithoutOwnerChanges],
		["deferred resolution: materialization does not repeat the tick", testInterruptedMaterializationDoesNotRepeatTick]
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