/*\
title: $:/plugins/clerus/core2/tests/mission-issuance.js
type: application/javascript
module-type: library
\*/

"use strict";

var issuance = require(
	"$:/plugins/clerus/core2/mission-issuance.js"
);

var missions = require(
	"$:/plugins/clerus/core2/missions.js"
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

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function initial() {
	return {
		root: {
			form: "mission",
			project: "Core2 Issuance Project",
			role: [],
			link: "10",
			issued: "0",
			children: {}
		}
	};
}

function testSharedCounter() {
	var source = initial();
	var before = JSON.stringify(source);

	var first = issuance.issue(source, "root", "a", "a");
	var second = issuance.issue(first.registry, "root", "b", "b");

	assert(first.link === "10/1");
	assert(second.link === "10/2");
	assert(second.registry.root.issued === "2");
	assert(second.registry.root.children.a === "10/1");
	assert(second.registry.root.children.b === "10/2");

	assert(JSON.stringify(source) === before);

	// The separately returned document does not alias the registry.
	first.document.issued = "99";
	assert(first.registry.a.issued === "0");
}

function testRevocationDoesNotReuse() {
	var first = issuance.issue(initial(), "root", "a", "old");

	var revoked = issuance.revoke(
		first.registry,
		"root",
		"a"
	);

	assert(revoked.registry.root.issued === "1");
	assert(revoked.registry.old.link === "10/1");

	var second = issuance.issue(
		revoked.registry,
		"root",
		"a",
		"replacement"
	);

	assert(second.link === "10/2");
	assert(second.registry.old.link === "10/1");
}

function testAliasesAdvanceTogether() {
	var registry = initial();
	registry.alias = clone(registry.root);

	var result = issuance.issue(
		registry,
		"root",
		"department",
		"department"
	);

	assert(result.parentKeys.join(",") === "alias,root");
	assert(result.registry.root.issued === "1");
	assert(result.registry.alias.issued === "1");

	assert(
		result.registry.root.children.department ===
			result.registry.alias.children.department
	);

	var revoked = issuance.revoke(
		result.registry,
		"alias",
		"department"
	);

	assert(
		!Object.prototype.hasOwnProperty.call(
			revoked.registry.root.children,
			"department"
		)
	);

	assert(
		!Object.prototype.hasOwnProperty.call(
			revoked.registry.alias.children,
			"department"
		)
	);
}

function testConflictingAliasesFailAtomically() {
	var registry = initial();
	registry.alias = clone(registry.root);
	registry.alias.issued = "1";

	var before = JSON.stringify(registry);

	throws(function () {
		issuance.issue(registry, "root", "a", "a");
	}, "conflicting aliases");

	assert(JSON.stringify(registry) === before);

	delete registry.alias.issued;
	before = JSON.stringify(registry);

	throws(function () {
		issuance.issue(registry, "root", "a", "a");
	}, "malformed alias");

	assert(JSON.stringify(registry) === before);
}

function testNestedNamespacesAndLargeCounter() {
	var first = issuance.issue(
		initial(),
		"root",
		"department",
		"department"
	);

	var nested = issuance.issue(
		first.registry,
		"department",
		"item",
		"item"
	);

	assert(nested.link === "10/1/1");
	assert(nested.registry.department.issued === "1");
	assert(nested.registry.root.issued === "1");

	var large = initial();
	large.root.issued = "999999999999999999999999";

	assert(
		issuance.issue(large, "root", "a", "a").link ===
			"10/1000000000000000000000000"
	);
}

function testSafeKeysAndOccupiedDestination() {
	var registry = initial();

	var result = issuance.issue(
		registry,
		"root",
		"__proto__",
		"__proto__"
	);

	assert(Object.getPrototypeOf(result.registry) === null);

	assert(
		result.registry.root.children.__proto__ === "10/1"
	);

	assert(result.registry.__proto__.form === "mission");

	var before = JSON.stringify(result.registry);

	throws(function () {
		issuance.issue(
			result.registry,
			"root",
			"another",
			"__proto__"
		);
	}, "already exists");

	assert(JSON.stringify(result.registry) === before);
}

function testDropRemovesAllRepresentations() {
	var registry = initial();
	registry.alias = clone(registry.root);

	var result = issuance.drop(registry, "alias");

	assert(result.removedKeys.join(",") === "alias,root");
	assert(Object.keys(result.registry).length === 0);
	assert(Object.keys(registry).length === 2);
}

function testDerivedDeactivation() {
	var registry = issuance.issue(
		initial(),
		"root",
		"department",
		"department"
	).registry;

	registry = issuance.issue(
		registry,
		"department",
		"item",
		"item"
	).registry;

	var jobs = [{
		title: "$:/clerus/jobs/issuance-owner",
		custody: "node",
		registry: registry
	}];

	assert(missions.evaluate(jobs).active.length === 3);

	var revoked = issuance.revoke(
		registry,
		"root",
		"department"
	);

	jobs[0].registry = revoked.registry;

	var report = missions.evaluate(jobs);

	assert(report.valid && report.complete);
	assert(report.active.length === 1);
	assert(revoked.registry.department);
	assert(revoked.registry.item);
}

exports.run = function () {
	var cases = [
		["issuance: siblings share one counter", testSharedCounter],
		["issuance: revoked generations are not reused", testRevocationDoesNotReuse],
		["issuance: aliases advance together", testAliasesAdvanceTogether],
		["issuance: conflicting aliases fail atomically", testConflictingAliasesFailAtomically],
		["issuance: nested namespaces and large counters", testNestedNamespacesAndLargeCounter],
		["issuance: safe keys and occupied destinations", testSafeKeysAndOccupiedDestination],
		["issuance: dropping consumes all representations", testDropRemovesAllRepresentations],
		["issuance: revocation deactivates without lower writes", testDerivedDeactivation]
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