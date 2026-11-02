/*\
title: $:/plugins/clerus/core/tests/mission-scope.js
type: application/javascript
module-type: library
\*/

"use strict";

var scopes = require("$:/plugins/clerus/core/scope.js");

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

function mission() {
	return {
		form: "mission",
		project: "Core2 Mission Scope Project",
		role: ["department"],
		link: "10/1",
		issued: "0",
		children: {}
	};
}

function operational() {
	return {
		charter: {
			form: "charter",
			status: {}
		}
	};
}

function testIncomingAccess() {
	var calls = 0;

	var scope = scopes.open({
		operational: operational(),
		incoming: { assignment: mission() },

		readMission: function (document, registries) {
			calls++;

			assert(document.link === "10/1");
			assert(registries.incoming.assignment);
			assert(!registries.operational.assignment);

			return {
				active: true,
				readable: true,
				task: { value: 42 },
				reason: null
			};
		}
	});

	var form;

	try {
		form = scope.incoming.get("assignment");

		var task = form.task();
		task.value = 99;

		assert(form.task().value === 42);
		assert(calls === 2);
	} finally {
		scope.close();
	}

	throws(function () {
		form.inspect();
	}, "closed");
}

function testServiceGetsIsolatedState() {
	var scope = scopes.open({
		operational: operational(),
		incoming: { assignment: mission() },

		readMission: function (document, registries) {
			document.link = "changed";
			registries.incoming.assignment.link = "changed";
			registries.operational.charter.status.changed = true;

			return {
				active: false,
				readable: false,
				task: null,
				reason: "Inactive mission"
			};
		}
	});

	try {
		var form = scope.incoming.get("assignment");

		assert(!form.inspect().active);

		var snapshot = scope.snapshot();

		assert(snapshot.incoming.assignment.link === "10/1");
		assert(
			!snapshot.operational.charter.status.changed
		);

		throws(function () {
			form.task();
		}, "Inactive mission");
	} finally {
		scope.close();
	}
}

function testActiveButUnavailable() {
	var scope = scopes.open({
		operational: operational(),
		incoming: { assignment: mission() },

		readMission: function () {
			return {
				active: true,
				readable: false,
				task: null,
				reason: "Project does not exist"
			};
		}
	});

	try {
		var form = scope.incoming.get("assignment");

		assert(form.inspect().active);

		throws(function () {
			form.task();
		}, "Project does not exist");
	} finally {
		scope.close();
	}
}

function testMutationIsNotAccidentallyEnabled() {
	var scope = scopes.open({
		operational: operational(),
		incoming: { assignment: mission() }
	});

	try {
		var outgoing = scope.incoming.outgoing();

		throws(function () {
			scope.incoming.copy(
				"assignment",
				outgoing,
				"assignment"
			);
		}, "cannot be copied");

		throws(function () {
			scope.incoming.move(
				"assignment",
				outgoing,
				"assignment"
			);
		}, "movement authorization is unavailable");

		assert(scope.incoming.keys().length === 1);
		assert(outgoing.keys().length === 0);

		scope.incoming.destroy("assignment");

		assert(scope.incoming.keys().length === 0);
		scope.assertResolved();
	} finally {
		scope.close();
	}
}

function testInvalidInspectionIsRejected() {
	var scope = scopes.open({
		operational: operational(),
		incoming: { assignment: mission() },

		readMission: function () {
			return {
				active: false,
				readable: true,
				task: {},
				reason: null
			};
		}
	});

	try {
		throws(function () {
			scope.incoming.get("assignment").inspect();
		}, "Invalid mission inspection result");
	} finally {
		scope.close();
	}
}

exports.run = function () {
	var cases = [
		["mission scope: incoming document exposes inspection", testIncomingAccess],
		["mission scope: service cannot mutate context", testServiceGetsIsolatedState],
		["mission scope: authority differs from readability", testActiveButUnavailable],
		["mission scope: incomplete mutation paths are blocked", testMutationIsNotAccidentallyEnabled],
		["mission scope: invalid inspection is rejected", testInvalidInspectionIsRejected]
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