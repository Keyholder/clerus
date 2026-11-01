/*\
title: $:/plugins/clerus/core2/tests/project-perspective.js
type: application/javascript
module-type: library
\*/

"use strict";

var perspectives = require(
	"$:/plugins/clerus/core2/project-perspective.js"
);

var Store = require("$:/plugins/clerus/core2/store.js").Store;

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function charter() {
	return { form: "charter", status: {} };
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var director = "$:/clerus/jobs/perspective-director";
	var owner = "$:/temp/clerus/jobs/" + platform + "/perspective-owner";
	var project = "Core2 Perspective Project";

	var root = {
		form: "mission",
		project: project,
		role: [],
		link: "10",
		issued: "1",
		children: { item: "10/1" }
	};

	var child = {
		form: "mission",
		project: project,
		role: ["item"],
		link: "10/1",
		issued: "0",
		children: {}
	};

	var jobs = [
		{
			title: director,
			custody: platform,
			registry: {
				charter: charter(),
				mission: root,
				subordinate: owner
			}
		},
		{
			title: owner,
			custody: platform,
			registry: {
				charter: charter()
			}
		}
	];

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "perspective-owner",
		text: JSON.stringify(jobs[1].registry)
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		text: JSON.stringify({
			task: { name: "root" },
			parts: {
				item: {
					task: { name: "child" },
					parts: {}
				}
			}
		})
	}));

	var service = perspectives.create({
		title: owner,
		store: new Store({
			wiki: wiki,
			Tiddler: tw.Tiddler
		}),
		readJobs: function () {
			return jobs;
		}
	});

	return {
		wiki: wiki,
		platform: platform,
		owner: owner,
		project: project,
		jobs: jobs,
		child: child,
		service: service,

		scope: function () {
			return {
				operational: clone(jobs[1].registry),
				incoming: { mission: clone(child) },
				outgoing: []
			};
		}
	};
}

function testIncomingAuthority(tw) {
	var f = fixture(tw);
	var before = JSON.stringify(f.jobs);
	var scope = f.scope();

	var view = f.service.readMission(f.child, scope);

	assert(view.active && view.readable);
	assert(view.task.name === "child");

	view.task.name = "local";
	assert(
		f.service.readMission(f.child, scope).task.name === "child"
	);

	assert(JSON.stringify(f.jobs) === before);
	assert(!scope.operational.mission);
}

function testOutgoingAuthority(tw) {
	var f = fixture(tw);
	var scope = f.scope();

	scope.incoming = {};
	scope.outgoing.push({ mission: clone(f.child) });

	var view = f.service.readMission(f.child, scope);

	assert(view.active && view.readable);
}

function testUnavailableDocument(tw) {
	var f = fixture(tw);
	var scope = f.scope();

	scope.incoming = {};

	var view = f.service.readMission(f.child, scope);

	assert(!view.active);
	assert(view.reason === "Mission is not available in this scope");
}

function testConflictingRepresentations(tw) {
	var f = fixture(tw);
	var scope = f.scope();

	scope.outgoing.push({
		mission: clone(f.child)
	});

	scope.outgoing[0].mission.issued = "1";

	var view = f.service.readMission(f.child, scope);

	assert(!view.active);
	assert(view.reason === "conflicting-copies");
}

function testProjectUnavailable(tw) {
	var f = fixture(tw);

	f.wiki.deleteTiddler(f.project);

	var view = f.service.readMission(f.child, f.scope());

	assert(view.active);
	assert(!view.readable);
	assert(view.reason === "Project does not exist");
}

function testEphemeralCustody(tw) {
	var f = fixture(tw);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.owner),
		{ "clerus-custody": "user" }
	));

	var view = f.service.readMission(f.child, f.scope());

	assert(!view.active);
	assert(view.reason === "ephemeral-custody");
}

function testMissingSubordination(tw) {
	var f = fixture(tw);

	delete f.jobs[0].registry.subordinate;

	var view = f.service.readMission(f.child, f.scope());

	assert(!view.active);
	assert(view.reason === "invalid-subordination");
}

exports.run = function (tw) {
	var cases = [
		["project perspective: incoming mission provides authority", testIncomingAuthority],
		["project perspective: outgoing mission remains available", testOutgoingAuthority],
		["project perspective: unavailable document provides no authority", testUnavailableDocument],
		["project perspective: conflicting representations are rejected", testConflictingRepresentations],
		["project perspective: unavailable project preserves authority", testProjectUnavailable],
		["project perspective: ephemeral custody is current", testEphemeralCustody],
		["project perspective: immediate subordination is required", testMissingSubordination]
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