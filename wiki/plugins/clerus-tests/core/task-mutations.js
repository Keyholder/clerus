/*\
title: $:/plugins/clerus/tests/core/task-mutations.js
type: application/javascript
module-type: library
\*/

"use strict";

var Store = require("$:/plugins/clerus/core/store.js").Store;
var jobState = require("$:/plugins/clerus/core/job-state.js");
var reactions = require("$:/plugins/clerus/core/reaction.js");
var planned = require("$:/plugins/clerus/core/planned-reaction.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function throws(fn, fragment) {
	var caught = null;

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

function fixture(tw, persistent) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = persistent
		? "$:/clerus/jobs/task-mutations-test"
		: "$:/temp/clerus/jobs/" + platform + "/task-mutations-test";

	var project = "Task Mutations Test Project";

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "task-mutations-test",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			mission: {
				form: "mission",
				project: project,
				role: [],
				link: "1",
				issued: "0",
				children: {}
			}
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: {},
			parts: {
				existing: {
					task: { old: true },
					parts: {
						leaf: { task: 7, parts: {} }
					}
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
		title: title,
		project: project,
		platform: platform,

		execute: function (handler) {
			var options = {
				store: store,
				title: title,
				platform: platform,
				event: { type: "test" },
				handler: handler,

				readJobs: function () {
					return jobState.readJobs(function (visit) {
						wiki.each(function (tiddler, title) {
							visit(tiddler.fields, title);
						});
					});
				}
			};

			return persistent
				? planned.execute(options)
				: reactions.execute(options);
		}
	};
}

function testImmediateMutation(tw) {
	var f = fixture(tw, false);

	f.execute(function (event, operational) {
		var mission = operational.get("mission");

		assert(mission.parts().join(",") === "existing");

		var input = { value: 42 };

		mission.createPart("item", input);
		input.value = 99;

		var child = mission.createMission(
			"item",
			operational,
			"child"
		);

		assert(child.task().value === 42);

		mission.setPartTask("existing", { updated: true });

		throws(function () {
			mission.createPart("item", {});
		}, "already exists");

		throws(function () {
			mission.setPartTask("missing", {});
		}, "does not exist");
	});

	var tree = JSON.parse(f.wiki.getTiddlerText(f.project));

	assert(tree.parts.item.task.value === 42);
	assert(tree.parts.existing.task.updated === true);
	assert(tree.parts.existing.parts.leaf.task === 7);
}

function testPlannedVisibility(tw) {
	var f = fixture(tw, true);
	var original = f.wiki.getTiddlerText(f.project);

	var proposal = f.execute(function (event, operational) {
		var mission = operational.get("mission");

		mission.createPart("item", { value: 42 });

		assert(mission.parts().indexOf("item") !== -1);

		var child = mission.createMission(
			"item",
			operational,
			"child"
		);

		assert(child.task().value === 42);

		mission.setPartTask("item", { value: 43 });
		assert(child.task().value === 43);

		assert(f.wiki.getTiddlerText(f.project) === original);
	});

	assert(f.wiki.getTiddlerText(f.project) === original);

	var effect = proposal.plan.effects.find(function (entry) {
		return entry.title === f.project;
	});

	assert(effect);
	assert(
		JSON.parse(effect.after.text).parts.item.task.value === 43
	);
}

function testFailedReactionDiscardsProjectChanges(tw) {
	var f = fixture(tw, true);
	var projectBefore = f.wiki.getTiddlerText(f.project);
	var jobBefore = f.wiki.getTiddlerText(f.title);

	throws(function () {
		f.execute(function (event, operational) {
			operational.get("mission").createPart(
				"item",
				{ value: 42 }
			);

			throw new Error("Reject the reaction");
		});
	}, "Reject the reaction");

	assert(f.wiki.getTiddlerText(f.project) === projectBefore);
	assert(f.wiki.getTiddlerText(f.title) === jobBefore);
}

function testProjectCustodyIsRequired(tw) {
	var f = fixture(tw, false);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.project),
		{ "clerus-custody": "user" }
	));

	var before = f.wiki.getTiddlerText(f.project);

	f.execute(function (event, operational) {
		var mission = operational.get("mission");

		// Read remains available.
		assert(mission.parts().join(",") === "existing");

		throws(function () {
			mission.createPart("item", {});
		}, "Project is not owned");
	});

	assert(f.wiki.getTiddlerText(f.project) === before);
}

function testRemovalDoesNotRevokeAssignment(tw) {
	var f = fixture(tw, false);

	f.execute(function (event, operational) {
		var mission = operational.get("mission");

		var child = mission.createMission(
			"existing",
			operational,
			"child"
		);

		assert(child.inspect().active);
		assert(child.inspect().readable);

		mission.removePart("existing");

		assert(mission.parts().length === 0);

		/*
		The assignment is still current, but its task has
		disappeared. This is not implicit revocation.
		*/
		assert(child.inspect().active);
		assert(!child.inspect().readable);

		throws(function () {
			child.task();
		}, "Task does not exist");

		// Explicit revocation remains available without the task.
		mission.revokePart("existing");

		assert(!child.inspect().active);
	});

	var tree = JSON.parse(f.wiki.getTiddlerText(f.project));

	assert(!Object.prototype.hasOwnProperty.call(
		tree.parts,
		"existing"
	));
}

function testPlannedRemovalPreservesOriginalUntilAcceptance(tw) {
	var f = fixture(tw, true);
	var original = f.wiki.getTiddlerText(f.project);

	var proposal = f.execute(function (event, operational) {
		var mission = operational.get("mission");

		mission.createPart("kept", { value: 42 });
		mission.removePart("existing");

		assert(mission.parts().join(",") === "kept");
		assert(f.wiki.getTiddlerText(f.project) === original);
	});

	assert(f.wiki.getTiddlerText(f.project) === original);

	var effect = proposal.plan.effects.find(function (entry) {
		return entry.title === f.project;
	});

	assert(effect);

	var after = JSON.parse(effect.after.text);

	assert(Object.keys(after.parts).join(",") === "kept");
	assert(after.parts.kept.task.value === 42);
}

function testMissingPartRemovalIsAtomic(tw) {
	var f = fixture(tw, false);

	f.execute(function (event, operational) {
		var mission = operational.get("mission");
		var before = f.wiki.getTiddlerText(f.project);

		throws(function () {
			mission.removePart("missing");
		}, "Task does not exist");

		assert(f.wiki.getTiddlerText(f.project) === before);
		assert(mission.parts().join(",") === "existing");

		// The rejected operation did not close or corrupt the scope.
		mission.createPart("later", { value: 7 });
	});

	var tree = JSON.parse(f.wiki.getTiddlerText(f.project));

	assert(tree.parts.existing.parts.leaf.task === 7);
	assert(tree.parts.later.task.value === 7);
}

exports.run = function (tw) {
	var cases = [
		["task mutations: immediate changes preserve descendants and isolate values", testImmediateMutation],
		["task mutations: planned changes are visible before materialization", testPlannedVisibility],
		["task mutations: failed persistent reaction leaves no project changes", testFailedReactionDiscardsProjectChanges],
		["task mutations: project custody is checked independently", testProjectCustodyIsRequired],
		["task mutations: task removal does not implicitly revoke assignment", testRemovalDoesNotRevokeAssignment],
		["task mutations: planned removal preserves the original project", testPlannedRemovalPreservesOriginalUntilAcceptance],
		["task mutations: missing part removal is atomic", testMissingPartRemovalIsAtomic]
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