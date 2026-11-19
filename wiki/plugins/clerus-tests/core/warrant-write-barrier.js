/*\
title: $:/plugins/clerus/tests/core/warrant-write-barrier.js
type: application/javascript
module-type: library
\*/

"use strict";

var barriers = require(
	"$:/plugins/clerus/core/materialization-barrier.js"
);
var continuations = require(
	"$:/plugins/clerus/core/continuations.js"
);
var proposalWork = require(
	"$:/plugins/clerus/core/proposal-work.js"
);
var reactions = require("$:/plugins/clerus/core/reaction.js");
var planned = require(
	"$:/plugins/clerus/core/planned-reaction.js"
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

function fixture(tw, readReservation) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";

	var owner = "$:/clerus/jobs/warrant-write-barrier-owner";
	var worker =
		"$:/temp/clerus/jobs/" + platform + "/warrant-write-barrier";

	var generated = "Generated/held";
	var sequence = 0;

	function newId() {
		sequence++;

		return "write-barrier-test-" +
			String(sequence).padStart(12, "0");
	}

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "barrier-owner",
		text: JSON.stringify({
			charter: { form: "charter", status: {} }
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: worker,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "barrier-worker",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			access: {
				form: "warrant",
				discover: [],
				generate: [{
					name: "note",
					titlePrefix: "Generated/",
					fields: { type: "text/plain" },
					inputFields: ["text"]
				}],
				edit: []
			}
		})
	}));

	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var proposal = planned.execute({
		store: store,
		title: owner,
		platform: platform,
		event: { type: "test" },

		handler: function () {
			// The test adds an explicit external transition below.
		}
	});

	proposal.plan.effects.push(stores.transition(
		readReservation ? "Other accepted target" : generated,
		null,
		{
			title: readReservation
				? "Other accepted target"
				: generated,
			"clerus-custody": platform,
			text: "Accepted content"
		}
	));

	var work = proposalWork.convert(
		proposal,
		newId(),
		platform
	);

	if (readReservation) {
		work.checks.push({
			title: generated,
			state: null
		});
	}

	var manager = continuations.create({
		store: store,
		platform: platform,
		newId: newId
	});

	var journal = manager.accept(work);

	return {
		wiki: wiki,
		store: store,
		platform: platform,
		owner: owner,
		worker: worker,
		generated: generated,
		journal: journal,
		manager: manager,

		barrier: function () {
			return barriers.collect({ store: store });
		},

		attemptGeneration: function () {
			return reactions.execute({
				store: store,
				title: worker,
				platform: platform,
				event: { type: "test" },

				newId: function () {
					return "held";
				},

				handler: function (event, operational) {
					var before = wiki.getTiddler(worker).fields.text;

					throws(function () {
						operational.get("access").generate(
							"note",
							{ text: "New content" },
							operational,
							"created"
						);
					}, "blocked by accepted work");

					assert(
						wiki.getTiddler(worker).fields.text === before
					);
					assert(!wiki.getTiddler(generated));
				}
			});
		}
	};
}

function testAcceptedWrite(tw) {
	var f = fixture(tw, false);

	assert(
		f.barrier().forWrite(f.generated).join(",") === f.journal
	);

	assert(f.barrier().forWrite("Unrelated title").length === 0);

	f.attemptGeneration();

	/*
	The instrumental barrier must not prevent accepted material replay.
	*/
	f.manager.resume(f.journal);

	assert(
		f.wiki.getTiddler(f.generated).fields.text ===
			"Accepted content"
	);
	assert(!f.wiki.getTiddler(f.journal));
	assert(f.barrier().forWrite(f.generated).length === 0);
}

function testAcceptedRead(tw) {
	var f = fixture(tw, true);

	assert(
		f.barrier().forWrite(f.generated).join(",") === f.journal
	);

	f.attemptGeneration();

	f.manager.resume(f.journal);

	assert(!f.wiki.getTiddler(f.generated));
	assert(!f.wiki.getTiddler(f.journal));
	assert(f.barrier().forWrite(f.generated).length === 0);
}

function testUserCustody(tw) {
	var f = fixture(tw, false);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.journal),
		{ "clerus-custody": "user" }
	));

	assert(
		f.barrier().forWrite(f.generated).join(",") === f.journal
	);

	f.attemptGeneration();
}

function testUnknownWal(tw) {
	var f = fixture(tw, false);
	var unknown =
		"$:/clerus/wal/" + f.platform + "/unknown-write-barrier";

	f.wiki.addTiddler(new tw.Tiddler({
		title: unknown,
		type: "application/json",
		"clerus-custody": "user",
		"clerus-wal-kind": "future",
		text: JSON.stringify({
			version: 99,
			kind: "future",
			platform: f.platform
		})
	}));

	var barrier = f.barrier();

	assert(!barrier.inspect().complete);
	assert(
		barrier.forWrite("Unrelated title").join(",") === unknown
	);

	f.attemptGeneration();
}

function testReturnedListsAreIsolated(tw) {
	var f = fixture(tw, false);
	var barrier = f.barrier();

	var result = barrier.forWrite(f.generated);
	result.length = 0;

	assert(
		barrier.forWrite(f.generated).join(",") === f.journal
	);

	throws(function () {
		barrier.forWrite("$:/System");
	}, "ordinary tiddler title");
}

exports.run = function (tw) {
	var cases = [
		["warrant write barrier: accepted write protects an absent target", testAcceptedWrite],
		["warrant write barrier: accepted read protects absence", testAcceptedRead],
		["warrant write barrier: user custody preserves protection", testUserCustody],
		["warrant write barrier: unknown WAL prevents new writes", testUnknownWal],
		["warrant write barrier: returned lists are isolated", testReturnedListsAreIsolated]
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