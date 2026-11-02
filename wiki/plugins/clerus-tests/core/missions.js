/*\
title: $:/plugins/clerus/core/tests/missions.js
type: application/javascript
module-type: library
\*/

"use strict";

var missions = require("$:/plugins/clerus/core/missions.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function grant(role, link, children) {
	return {
		form: "mission",
		project: "Core2 Authority Project",
		role: role,
		link: link,
		issued: "0",
		children: children || {}
	};
}

function fixture() {
	var director = "$:/clerus/jobs/director";
	var manager = "$:/clerus/jobs/manager";
	var worker = "$:/temp/clerus/jobs/browser/worker";

	return [
		{
			title: director,
			custody: "user",
			registry: {
				mission: grant([], "10", { department: "10/1" }),
				subordinate: manager
			}
		},
		{
			title: manager,
			custody: "node",
			registry: {
				mission: grant(
					["department"],
					"10/1",
					{ item: "10/1/1" }
				),
				subordinate: worker
			}
		},
		{
			title: worker,
			custody: "browser",
			registry: {
				mission: grant(
					["department", "item"],
					"10/1/1"
				)
			}
		}
	];
}

function testChain() {
	var jobs = fixture();
	var before = JSON.stringify(jobs);
	var report = missions.evaluate(jobs);

	assert(report.valid && report.complete);
	assert(report.active.length === 3);
	assert(JSON.stringify(jobs) === before);

	// No project tiddler is needed to establish authority.
	assert(report.entries.every(function (entry) {
		return entry.active;
	}));
}

function testEphemeralCustody() {
	var jobs = fixture();

	jobs[2].custody = "user";

	var report = missions.evaluate(jobs);

	assert(report.valid && report.complete);
	assert(report.active.length === 2);
	assert(report.entries.some(function (entry) {
		return entry.title === jobs[2].title &&
			entry.reason === "ephemeral-custody";
	}));

	// The organizational relationship still exists.
	assert(report.hierarchy.edges.some(function (edge) {
		return edge.to === jobs[2].title;
	}));

	assert(jobs[2].registry.mission);
}

function testAliases() {
	var jobs = fixture();

	jobs[1].registry.alias =
		clone(jobs[1].registry.mission);

	var report = missions.evaluate(jobs);

	assert(report.active.length === 3);

	var manager = report.active.filter(function (entry) {
		return entry.title === jobs[1].title;
	})[0];

	assert(manager.keys.join(",") === "alias,mission");

	jobs[1].registry.alias.children.item = "10/1/2";

	report = missions.evaluate(jobs);

	assert(!report.valid);
	assert(report.active.length === 1);
	assert(report.issues.some(function (issue) {
		return issue.type === "conflicting-copies";
	}));
}

function testAmbiguousHolder() {
	var jobs = fixture();

	jobs.push({
		title: "$:/clerus/jobs/competing-manager",
		custody: "node",
		registry: {
			mission: clone(jobs[1].registry.mission)
		}
	});

	var report = missions.evaluate(jobs);

	assert(!report.valid);
	assert(report.active.length === 1);
	assert(report.issues.some(function (issue) {
		return issue.type === "ambiguous-holder";
	}));
}

function testBindingRevocation() {
	var jobs = fixture();

	delete jobs[0].registry.mission.children.department;

	var report = missions.evaluate(jobs);

	assert(report.valid);
	assert(report.active.length === 1);
	assert(jobs[1].registry.mission);
	assert(jobs[2].registry.mission);
}

function testDirectSubordination() {
	var jobs = fixture();

	delete jobs[1].registry.subordinate;
	jobs[0].registry.worker = jobs[2].title;

	var report = missions.evaluate(jobs);

	assert(report.hierarchy.valid);
	assert(report.active.length === 2);
	assert(report.entries.some(function (entry) {
		return entry.title === jobs[2].title &&
			entry.reason === "invalid-subordination";
	}));
}

function testNewestRootDoesNotFallBack() {
	var jobs = fixture();

	jobs.push({
		title: "$:/temp/clerus/jobs/browser/new-director",
		custody: "user",
		registry: {
			mission: grant([], "11")
		}
	});

	var report = missions.evaluate(jobs);

	assert(report.valid);
	assert(report.active.length === 0);

	// Only removal of the newer root makes the old one selectable again.
	jobs.pop();

	assert(missions.evaluate(jobs).active.length === 3);
}

function testIncompleteHierarchy() {
	var jobs = fixture();

	jobs.push({
		title: "$:/clerus/jobs/unreadable",
		custody: "node",
		registry: null
	});

	var report = missions.evaluate(jobs);

	assert(!report.complete);
	assert(report.active.length === 0);
	assert(report.entries.every(function (entry) {
		return entry.reason === "incomplete-hierarchy";
	}));
}

function testInvalidRoot() {
	var jobs = fixture();

	jobs.push({
		title: "$:/clerus/jobs/broken-root",
		custody: "node",
		registry: {
			mission: {
				form: "mission",
				project: "Core2 Authority Project",
				role: [],
				link: "20"
			}
		}
	});

	var report = missions.evaluate(jobs);

	assert(!report.valid);
	assert(!report.complete);
	assert(report.active.length === 0);
	assert(report.issues.some(function (issue) {
		return issue.type === "invalid-mission";
	}));
}

exports.run = function () {
	var cases = [
		["missions: authority follows the chain", testChain],
		["missions: ephemeral custody gates authority", testEphemeralCustody],
		["missions: aliases share authority", testAliases],
		["missions: several holders are ambiguous", testAmbiguousHolder],
		["missions: binding revocation deactivates descendants", testBindingRevocation],
		["missions: subordination must be immediate", testDirectSubordination],
		["missions: inactive newest root does not select older root", testNewestRootDoesNotFallBack],
		["missions: incomplete hierarchy prevents authorization", testIncompleteHierarchy],
		["missions: malformed root prevents root selection", testInvalidRoot]
	];

	var results = cases.map(function (item) {
		try {
			item[1]();

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