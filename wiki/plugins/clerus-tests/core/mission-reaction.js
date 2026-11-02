/*\
title: $:/plugins/clerus/tests/core/mission-reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

var reactions = require("$:/plugins/clerus/core/reaction.js");
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

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function fixture(tw, operationalMission) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner =
		"$:/temp/clerus/jobs/" + platform + "/mission-reaction";
	var director = "$:/clerus/jobs/mission-reaction-director";
	var project = "Core2 Mission Reaction Project";

	var child = {
		form: "mission",
		project: project,
		role: ["item"],
		link: "10/1",
		issued: "0",
		children: {}
	};

	var registry = {
		charter: {
			form: "charter",
			status: {}
		}
	};

	if (operationalMission) {
		registry.assignment = clone(child);
	}

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "mission-reaction",
		text: JSON.stringify(registry)
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

	function readJobs() {
		var stored = wiki.getTiddler(owner);

		return [
			{
				title: director,
				custody: platform,
				registry: {
					mission: {
						form: "mission",
						project: project,
						role: [],
						link: "10",
						issued: "1",
						children: { item: "10/1" }
					},
					subordinate: owner
				}
			},
			{
				title: owner,
				custody: stored.fields["clerus-custody"],
				registry: JSON.parse(stored.fields.text)
			}
		];
	}

	return {
		wiki: wiki,
		owner: owner,
		platform: platform,
		child: child,

		execute: function (handler, incoming) {
			return reactions.execute({
				store: store,
				title: owner,
				platform: platform,
				event: { type: "test" },
				readJobs: readJobs,
				handler: handler,
				incoming: incoming
			});
		},

		registry: function () {
			return JSON.parse(
				wiki.getTiddler(owner).fields.text
			);
		}
	};
}

function testIncomingMission(tw) {
	var f = fixture(tw, false);
	var before = f.wiki.getTiddler(f.owner).fields.text;
	var saved;

	f.execute(function (event, operational, incoming) {
		saved = incoming.get("assignment");

		assert(saved.inspect().active);
		assert(saved.task().value === 42);
		assert(operational.keys().length === 1);

		incoming.destroy("assignment");
	}, {
		assignment: clone(f.child)
	});

	assert(f.wiki.getTiddler(f.owner).fields.text === before);

	throws(function () {
		saved.task();
	}, "closed");
}

function testSharedRepresentations(tw) {
	var f = fixture(tw, true);

	f.execute(function (event, operational, incoming) {
		var first = operational.get("assignment");
		var second = incoming.get("alias");

		assert(first === second);
		assert(first.inspect().active);

		incoming.destroy("alias");

		assert(operational.keys().join(",") === "charter");
		assert(incoming.keys().length === 0);

		throws(function () {
			first.inspect();
		}, "no longer available");
	}, {
		alias: clone(f.child)
	});

	assert(!f.registry().assignment);
}

function testDeniedDestruction(tw) {
	var f = fixture(tw, true);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.owner),
		{ "clerus-custody": "user" }
	));

	var before = f.wiki.getTiddler(f.owner).fields.text;

	throws(function () {
		f.execute(function (event, operational, incoming) {
			var form = incoming.get("alias");

			assert(!form.inspect().active);

			throws(function () {
				incoming.destroy("alias");
			}, "not writable");

			assert(incoming.keys().length === 1);
			assert(operational.get("assignment") === form);
		}, {
			alias: clone(f.child)
		});
	}, "unresolved");

	assert(f.wiki.getTiddler(f.owner).fields.text === before);
}

function testConflictingRepresentationsCanBeDestroyed(tw) {
	var f = fixture(tw, true);
	var conflicting = clone(f.child);

	conflicting.issued = "1";

	f.execute(function (event, operational, incoming) {
		assert(
			operational.get("assignment") !==
				incoming.get("alias")
		);

		assert(!incoming.get("alias").inspect().active);

		incoming.destroy("alias");

		assert(!operational.keys().includes("assignment"));
		assert(incoming.keys().length === 0);
	}, {
		alias: conflicting
	});

	assert(!f.registry().assignment);
}

exports.run = function (tw) {
	var cases = [
		["mission reaction: incoming authority without filing", testIncomingMission],
		["mission reaction: representations share access", testSharedRepresentations],
		["mission reaction: denied destruction is atomic", testDeniedDestruction],
		["mission reaction: conflicting representations permit cleanup", testConflictingRepresentationsCanBeDestroyed]
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