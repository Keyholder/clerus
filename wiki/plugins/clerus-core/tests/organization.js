/*\
title: $:/plugins/clerus/core/tests/organization.js
type: application/javascript
module-type: library
\*/

"use strict";

var scopes = require("$:/plugins/clerus/core/scope.js");
var organizations = require(
	"$:/plugins/clerus/core/organization.js"
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

function base() {
	return {
		charter: { form: "charter", status: {} }
	};
}

function fixture(owner, target, otherJobs) {
	var stored = base();
	var writes = 0;

	var service = organizations.create({
		title: owner,
		readJobs: function () {
			return [{
				title: owner,
				registry: stored
			}].concat(otherJobs || []);
		}
	});

	var scope = scopes.open({
		operational: stored,
		incoming: { target: target },

		canWriteOperational: function () {
			return true;
		},

		commitOperational: function (before, after) {
			stored = after;
			writes++;
		},

		authorizeOrganization: service.authorizeChange
	});

	return {
		scope: scope,
		writes: function () {
			return writes;
		}
	};
}

function testNewReference() {
	var owner = "$:/clerus/jobs/organization-owner";
	var target = "$:/clerus/jobs/organization-target";

	// An absent target is a valid future subordinate address.
	var f = fixture(owner, target);

	try {
		var title = f.scope.incoming.get("target");

		f.scope.incoming.move(
			"target",
			f.scope.operational,
			"subordinate"
		);

		assert(f.scope.operational.get("subordinate") === title);
		assert(f.writes() === 1);
		f.scope.assertResolved();
	} finally {
		f.scope.close();
	}
}

function testCycleIsAtomic() {
	var owner = "$:/clerus/jobs/cycle-owner";
	var target = "$:/clerus/jobs/cycle-target";

	var f = fixture(owner, target, [{
		title: target,
		registry: { superiorReference: owner }
	}]);

	try {
		var before = JSON.stringify(f.scope.snapshot());

		throws(function () {
			f.scope.incoming.move(
				"target",
				f.scope.operational,
				"subordinate"
			);
		}, "hierarchy invariants");

		assert(JSON.stringify(f.scope.snapshot()) === before);
		assert(f.writes() === 0);
	} finally {
		f.scope.close();
	}
}

function testSelfReference() {
	var owner = "$:/clerus/jobs/self-reference";
	var f = fixture(owner, owner);

	try {
		throws(function () {
			f.scope.incoming.move(
				"target",
				f.scope.operational,
				"self"
			);
		}, "hierarchy invariants");

		assert(f.writes() === 0);
	} finally {
		f.scope.close();
	}
}

function testDurabilityRestriction() {
	var f = fixture(
		"$:/temp/clerus/jobs/browser/ephemeral-owner",
		"$:/clerus/jobs/persistent-target"
	);

	try {
		throws(function () {
			f.scope.incoming.move(
				"target",
				f.scope.operational,
				"subordinate"
			);
		}, "hierarchy invariants");

		assert(f.writes() === 0);

		var outgoing = f.scope.incoming.outgoing();

		// Placement is not yet sending to a specific recipient.
		f.scope.incoming.move("target", outgoing, "target");

		assert(outgoing.keys().length === 1);
		assert(f.writes() === 0);
	} finally {
		f.scope.close();
	}
}

function testIncompleteGraph() {
	var f = fixture(
		"$:/clerus/jobs/complete-owner",
		"$:/clerus/jobs/future-target",
		[{
			title: "$:/clerus/jobs/unreadable",
			registry: null
		}]
	);

	try {
		throws(function () {
			f.scope.incoming.move(
				"target",
				f.scope.operational,
				"subordinate"
			);
		}, "incomplete hierarchy");

		assert(f.writes() === 0);
	} finally {
		f.scope.close();
	}
}

function testDuplicateReferenceDoesNotCreateAnotherEdge() {
	var owner = "$:/clerus/jobs/duplicate-owner";
	var target = "$:/clerus/jobs/duplicate-target";
	var f = fixture(owner, target);

	try {
		f.scope.incoming.move(
			"target",
			f.scope.operational,
			"first"
		);

		f.scope.operational.copy(
			"first",
			f.scope.operational,
			"second"
		);

		assert(
			f.scope.operational.get("first") ===
				f.scope.operational.get("second")
		);

		f.scope.operational.destroy("first");

		assert(f.scope.operational.keys().includes("second"));
		assert(f.writes() === 3);
	} finally {
		f.scope.close();
	}
}

exports.run = function () {
	var cases = [
		["organization: new operational reference", testNewReference],
		["organization: cycle rejection is atomic", testCycleIsAtomic],
		["organization: self-reference is rejected", testSelfReference],
		["organization: ephemeral superior restriction", testDurabilityRestriction],
		["organization: incomplete graph prevents new edge", testIncompleteGraph],
		["organization: duplicate references preserve one edge", testDuplicateReferenceDoesNotCreateAnotherEdge]
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