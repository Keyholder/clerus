/*\
title: $:/plugins/clerus/core2/tests/establishment-reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

var reactions = require("$:/plugins/clerus/core2/reaction.js");
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
	var title =
		"$:/temp/clerus/jobs/" + platform + "/newborn";

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	return {
		wiki: wiki,
		title: title,

		run: function (handler, temp) {
			return reactions.establish({
				store: store,
				title: title,
				platform: platform,

				incoming: {
					contract: {
						form: "contract",
						executor: "newborn-executor",
						temp: temp === undefined ? true : temp,
						book: { instruction: "test" }
					},
					note: {
						form: "memo",
						data: { value: 42 }
					}
				},

				resolveExecutor: function (name) {
					assert(name === "newborn-executor");
					return handler;
				}
			});
		},

		registry: function () {
			return JSON.parse(
				wiki.getTiddler(title).fields.text
			);
		}
	};
}

function testExplicitBirth(tw) {
	var f = fixture(tw);
	var saved;

	f.run(function (event, operational, incoming) {
		assert(event.type === "order");
		assert(event.title === f.title);
		assert(!f.wiki.getTiddler(f.title));

		throws(function () {
			operational.keys();
		}, "not established");

		var charter = incoming.get("contract").accept(
			"charter",
			{ phase: "starting" }
		);

		assert(f.wiki.getTiddler(f.title));
		assert(charter === operational.get("charter"));
		assert(charter.book().instruction === "test");

		// The remaining payload has not been accepted automatically.
		assert(operational.keys().join(",") === "charter");

		incoming.move("note", operational, "note");

		charter.setStatus({ phase: "running" });

		saved = operational.get("note");
		assert(saved.data().value === 42);
	});

	assert(f.registry().charter.status.phase === "running");
	assert(f.registry().note.data.value === 42);

	throws(function () {
		saved.data();
	}, "closed");
}

function testFailureBeforeAcceptance(tw) {
	var f = fixture(tw);

	throws(function () {
		f.run(function () {
			throw new Error("Failure before acceptance");
		});
	}, "Failure before acceptance");

	assert(!f.wiki.getTiddler(f.title));
}

function testFailureAfterAcceptance(tw) {
	var f = fixture(tw);

	throws(function () {
		f.run(function (event, operational, incoming) {
			incoming.get("contract").accept(
				"charter",
				{ phase: "accepted" }
			);

			throw new Error("Failure after acceptance");
		});
	}, "Failure after acceptance");

	assert(f.wiki.getTiddler(f.title));
	assert(f.registry().charter.status.phase === "accepted");
	assert(!f.registry().note);
}

function testUnacceptedContract(tw) {
	var f = fixture(tw);

	throws(function () {
		f.run(function (event, operational, incoming) {
			incoming.destroy("contract");
			incoming.destroy("note");
		});
	}, "was not accepted");

	assert(!f.wiki.getTiddler(f.title));
}

function testUnresolvedPayload(tw) {
	var f = fixture(tw);

	throws(function () {
		f.run(function (event, operational, incoming) {
			incoming.get("contract").accept("charter", {});
		});
	}, "unresolved");

	// Birth is an already materialized ephemeral effect.
	assert(f.wiki.getTiddler(f.title));
	assert(!f.registry().note);
}

function testContractDurability(tw) {
	var f = fixture(tw);
	var invoked = false;

	throws(function () {
		f.run(function () {
			invoked = true;
		}, false);
	}, "forbids ephemeral establishment");

	assert(!invoked);
	assert(!f.wiki.getTiddler(f.title));
}

function testOccupiedTarget(tw) {
	var f = fixture(tw);

	f.wiki.addTiddler(new tw.Tiddler({
		title: f.title,
		text: "existing"
	}));

	var invoked = false;

	throws(function () {
		f.run(function () {
			invoked = true;
		});
	}, "target must be absent");

	assert(!invoked);
	assert(f.wiki.getTiddlerText(f.title) === "existing");
}

exports.run = function (tw) {
	var cases = [
		["establishment reaction: birth is explicitly accepted", testExplicitBirth],
		["establishment reaction: failure before acceptance leaves no job", testFailureBeforeAcceptance],
		["establishment reaction: failure after acceptance preserves birth", testFailureAfterAcceptance],
		["establishment reaction: discarded contract does not establish", testUnacceptedContract],
		["establishment reaction: remaining payload must be resolved", testUnresolvedPayload],
		["establishment reaction: contract constrains durability", testContractDurability],
		["establishment reaction: occupied target is not invoked", testOccupiedTarget]
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