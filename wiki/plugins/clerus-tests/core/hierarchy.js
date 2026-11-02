/*\
title: $:/plugins/clerus/core/tests/hierarchy.js
type: application/javascript
module-type: library
\*/

"use strict";

var jobTitles = require(
	"$:/plugins/clerus/core/job-titles.js"
);

var hierarchy = require(
	"$:/plugins/clerus/core/hierarchy.js"
);

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

function persistent(name) {
	return "$:/clerus/jobs/" + name;
}

function ephemeral(name) {
	return "$:/temp/clerus/jobs/browser/" + name;
}

function testClassification() {
	assert(jobTitles.classify(persistent("a")).persistent);

	var temporary = jobTitles.classify(ephemeral("a"));

	assert(!temporary.persistent);
	assert(temporary.platform === "browser");

	assert(!jobTitles.isJobTitle("$:/clerus/jobs/"));
	assert(!jobTitles.isJobTitle("Ordinary Title"));
	assert(!jobTitles.isJobTitle(null));
}

function testAliasesAndNestedData() {
	var superior = persistent("superior");
	var subordinate = persistent("subordinate");

	var report = hierarchy.evaluate([
		{
			title: superior,
			custody: "user",
			registry: {
				first: subordinate,
				second: subordinate,
				memo: {
					form: "memo",
					data: {
						notAnEdge: superior
					}
				}
			}
		},
		{
			title: subordinate,
			registry: {}
		}
	]);

	assert(report.valid && report.complete);
	assert(report.edges.length === 1);
	assert(report.edges[0].keys.join(",") === "first,second");
	assert(report.unresolved.length === 0);
}

function testCycles() {
	var a = persistent("a");
	var b = persistent("b");
	var self = persistent("self");

	var report = hierarchy.evaluate([
		{ title: a, registry: { child: b } },
		{ title: b, registry: { child: a } },
		{ title: self, registry: { self: self } }
	]);

	assert(!report.valid);
	assert(report.complete);

	var cycles = report.violations.filter(function (violation) {
		return violation.type === "cycle";
	});

	assert(cycles.length === 2);

	assert(cycles.some(function (cycle) {
		return cycle.titles.join(",") === [a, b].join(",");
	}));

	assert(cycles.some(function (cycle) {
		return cycle.titles.length === 1 &&
			cycle.titles[0] === self;
	}));
}

function testDurabilityLimits() {
	var report = hierarchy.evaluate([
		{
			title: ephemeral("superior"),
			registry: {
				child: persistent("not-yet-created")
			}
		}
	]);

	assert(!report.valid);
	assert(report.complete);
	assert(report.unresolved.length === 1);
	assert(report.violations[0].type === "ephemeral-superior");

	var legal = hierarchy.evaluate([
		{
			title: persistent("superior"),
			registry: {
				child: ephemeral("subordinate")
			}
		}
	]);

	assert(legal.valid && legal.complete);
	assert(legal.unresolved.length === 1);
}

function testIncompleteKnowledge() {
	var a = persistent("a");
	var b = persistent("b");

	var report = hierarchy.evaluate([
		{ title: a, registry: { child: b } },
		{ title: b, registry: null }
	]);

	assert(report.valid);
	assert(!report.complete);
	assert(report.uninspectable.join(",") === b);
	assert(report.edges.length === 1);
}

function testMultipleSuperiors() {
	var child = persistent("child");

	var report = hierarchy.evaluate([
		{
			title: persistent("first"),
			registry: { child: child }
		},
		{
			title: persistent("second"),
			registry: { child: child }
		},
		{
			title: child,
			registry: {}
		}
	]);

	assert(report.valid && report.complete);
	assert(report.edges.length === 2);
}

function testIsolation() {
	var jobs = [
		{
			title: persistent("a"),
			registry: {
				child: persistent("b")
			}
		}
	];

	var before = JSON.stringify(jobs);
	var report = hierarchy.evaluate(jobs);

	report.edges[0].keys.push("local");
	report.unresolved[0].to = "local";

	assert(JSON.stringify(jobs) === before);
}

function testDuplicateInput() {
	throws(function () {
		hierarchy.evaluate([
			{ title: persistent("a"), registry: {} },
			{ title: persistent("a"), registry: {} }
		]);
	}, "Duplicate hierarchy job title");
}

exports.run = function () {
	var cases = [
		["hierarchy: title classification", testClassification],
		["hierarchy: aliases and document boundaries", testAliasesAndNestedData],
		["hierarchy: cycles and self-reference", testCycles],
		["hierarchy: durability restrictions", testDurabilityLimits],
		["hierarchy: incomplete knowledge is explicit", testIncompleteKnowledge],
		["hierarchy: several superiors are legal", testMultipleSuperiors],
		["hierarchy: evaluation does not mutate input", testIsolation],
		["hierarchy: duplicate input is rejected", testDuplicateInput]
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