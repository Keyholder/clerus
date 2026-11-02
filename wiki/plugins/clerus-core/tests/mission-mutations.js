/*\
title: $:/plugins/clerus/core/tests/mission-mutations.js
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

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title =
		"$:/temp/clerus/jobs/" + platform + "/mission-mutations";
	var project = "Core2 Mission Mutations Project";

	var root = {
		form: "mission",
		project: project,
		role: [],
		link: "10",
		issued: "0",
		children: {}
	};

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "mission-mutations",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			root: root,
			alias: clone(root)
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: {},
			parts: {
				item: { task: { value: 42 }, parts: {} }
			}
		})
	}));

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	function registry() {
		return JSON.parse(wiki.getTiddler(title).fields.text);
	}

	return {
		wiki: wiki,
		title: title,
		project: project,
		registry: registry,

		execute: function (handler) {
			return reactions.execute({
				store: store,
				title: title,
				platform: platform,
				event: { type: "test" },
				readJobs: function () {
					return [{
						title: title,
						custody: platform,
						registry: registry()
					}];
				},
				handler: handler
			});
		}
	};
}

function testIssueAndRevoke(tw) {
	var f = fixture(tw);

	f.execute(function (event, operational) {
		var parent = operational.get("root");

		assert(parent === operational.get("alias"));

		var child = parent.createMission(
			"item",
			operational,
			"child"
		);

		assert(child.inspect().active);
		assert(child.task().value === 42);

		parent.revokePart("item");

		assert(!child.inspect().active);

		var replacement = parent.createMission(
			"item",
			operational,
			"replacement"
		);

		assert(replacement.inspect().active);
		assert(!child.inspect().active);
	});

	var registry = f.registry();

	assert(registry.root.issued === "2");
	assert(registry.alias.issued === "2");
	assert(registry.root.children.item === "10/2");
	assert(registry.alias.children.item === "10/2");
	assert(registry.child.link === "10/1");
	assert(registry.replacement.link === "10/2");
}

function testOccupiedDestinationIsAtomic(tw) {
	var f = fixture(tw);

	f.execute(function (event, operational) {
		var before = f.wiki.getTiddler(f.title).fields.text;

		throws(function () {
			operational.get("root").createMission(
				"item",
				operational,
				"charter"
			);
		}, "already exists");

		assert(
			f.wiki.getTiddler(f.title).fields.text === before
		);
		assert(operational.get("root").inspect().active);
	});

	assert(f.registry().root.issued === "0");
}

function testProjectCustody(tw) {
	var f = fixture(tw);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.project),
		{ "clerus-custody": "user" }
	));

	f.execute(function (event, operational) {
		throws(function () {
			operational.get("root").createMission(
				"item",
				operational,
				"child"
			);
		}, "Project is not owned");
	});

	assert(f.registry().root.issued === "0");
	assert(!f.registry().child);
}

function testRevocationWithoutProject(tw) {
	var f = fixture(tw);

	f.execute(function (event, operational) {
		operational.get("root").createMission(
			"item",
			operational,
			"child"
		);
	});

	f.wiki.deleteTiddler(f.project);

	f.execute(function (event, operational) {
		var parent = operational.get("root");

		assert(parent.inspect().active);
		assert(!parent.inspect().readable);

		parent.revokePart("item");

		assert(!operational.get("child").inspect().active);
	});

	assert(f.registry().root.issued === "1");
	assert(!f.registry().root.children.item);
}

function testMissingTaskIsAtomic(tw) {
	var f = fixture(tw);

	f.execute(function (event, operational) {
		throws(function () {
			operational.get("root").createMission(
				"missing",
				operational,
				"child"
			);
		}, "Task does not exist");
	});

	assert(f.registry().root.issued === "0");
	assert(!f.registry().child);
}

exports.run = function (tw) {
	var cases = [
		["mission mutations: issuance, revocation and replacement", testIssueAndRevoke],
		["mission mutations: occupied destination is atomic", testOccupiedDestinationIsAtomic],
		["mission mutations: project custody is independent", testProjectCustody],
		["mission mutations: unavailable project does not prevent revocation", testRevocationWithoutProject],
		["mission mutations: missing task leaves no effects", testMissingTaskIsAtomic]
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