/*\
title: $:/plugins/clerus/core/tests/planned-establishment.js
type: application/javascript
module-type: library
\*/

"use strict";

var reactions = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
var proposals = require(
	"$:/plugins/clerus/core/proposal-schema.js"
);
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

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = "$:/clerus/jobs/planned-founder";
	var target = "$:/clerus/jobs/planned-newborn";
	var project = "Core2 Planned Establishment Project";

	wiki.addTiddler(new tw.Tiddler({
		title: source,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "founder",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			target: target,
			root: {
				form: "mission",
				project: project,
				role: [],
				link: "10",
				issued: "1",
				children: { item: "10/1" }
			}
		})
	}));

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

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	return {
		wiki: wiki,
		target: target,

		run: function (handler) {
			return reactions.establish({
				store: store,
				title: target,
				platform: platform,
				event: {
					type: "order",
					id: "planned-establishment-event-0001"
				},

				incoming: {
					contract: {
						form: "contract",
						executor: "worker",
						temp: false,
						book: { instruction: "start" }
					},
					assignment: {
						form: "mission",
						project: project,
						role: ["item"],
						link: "10/1",
						issued: "0",
						children: {}
					}
				},

				resolveExecutor: function (name) {
					assert(name === "worker");
					return handler;
				}
			});
		}
	};
}

function testBirthRemainsVirtual(tw) {
	var f = fixture(tw);
	var saved;

	var proposal = f.run(function (event, operational, incoming) {
		assert(!f.wiki.getTiddler(f.target));

		var assignment = incoming.get("assignment");

		assert(!assignment.inspect().active);

		var charter = incoming.get("contract").accept(
			"charter",
			{ phase: "starting" }
		);

		assert(!f.wiki.getTiddler(f.target));
		assert(charter === operational.get("charter"));
		assert(assignment.inspect().active);
		assert(assignment.task().value === 42);

		incoming.move("assignment", operational, "mission");
		charter.setStatus({ phase: "running" });

		saved = charter;
	});

	assert(!f.wiki.getTiddler(f.target));
	assert(proposal.owner.state === null);

	var normalized = proposals.validate(proposal, {
		allowMessages: true
	});

	assert(normalized.plan.effects.length === 1);

	var birth = normalized.plan.effects[0];

	assert(birth.before === null);

	var registry = JSON.parse(birth.after.text);

	assert(registry.charter.book.instruction === "start");
	assert(registry.charter.status.phase === "running");
	assert(registry.mission.link === "10/1");

	throws(function () {
		saved.status();
	}, "closed");
}

function testFailureAfterVirtualAcceptanceCreatesNothing(tw) {
	var f = fixture(tw);
	var saved;

	throws(function () {
		f.run(function (event, operational, incoming) {
			saved = incoming.get("contract").accept("charter", {});

			incoming.move("assignment", operational, "mission");

			throw new Error("Initialization rejected");
		});
	}, "Initialization rejected");

	assert(!f.wiki.getTiddler(f.target));

	throws(function () {
		saved.status();
	}, "closed");
}

function testUnresolvedPayloadRejectsBirth(tw) {
	var f = fixture(tw);

	throws(function () {
		f.run(function (event, operational, incoming) {
			incoming.get("contract").accept("charter", {});
		});
	}, "unresolved");

	assert(!f.wiki.getTiddler(f.target));
}

exports.run = function (tw) {
	var cases = [
		["planned establishment: acceptance creates only virtual state", testBirthRemainsVirtual],
		["planned establishment: failed initialization creates nothing", testFailureAfterVirtualAcceptanceCreatesNothing],
		["planned establishment: payload must be explicitly resolved", testUnresolvedPayloadRejectsBirth]
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