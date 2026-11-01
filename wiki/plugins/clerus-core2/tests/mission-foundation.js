/*\
title: $:/plugins/clerus/core2/tests/mission-foundation.js
type: application/javascript
module-type: library
\*/

"use strict";

var roles = require("$:/plugins/clerus/core2/roles.js");
var generations = require(
	"$:/plugins/clerus/core2/generations.js"
);
var missions = require(
	"$:/plugins/clerus/core2/mission-schema.js"
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

function mission() {
	return {
		form: "mission",
		project: "Mission Foundation Project",
		role: [],
		link: "10",
		issued: "0",
		children: {}
	};
}

function testRoles() {
	assert(roles.stringify([]) === "");
	assert(roles.parse("").length === 0);

	var role = ["Отдел", "Item 1", "a%b"];

	assert(
		JSON.stringify(roles.parse(roles.stringify(role))) ===
			JSON.stringify(role)
	);

	[
		"",
		".",
		"..",
		"a/b",
		"a\\b",
		"a?b",
		"a#b",
		"\u0000",
		"\u0080",
		"\ud800"
	].forEach(function (segment) {
		assert(!roles.isSegment(segment));
	});

	assert(!roles.isRole(new Array(1)));

	throws(function () {
		roles.parse("%61");
	}, "Non-canonical");

	throws(function () {
		roles.parse("a%2Fb");
	});

	assert(roles.stringify(["!"]) === "%21");
}

function testOrdinals() {
	assert(generations.increment("0") === "1");
	assert(generations.increment("9") === "10");
	assert(generations.increment("1099") === "1100");

	assert(
		generations.increment("999999999999999999999999") ===
			"1000000000000000000000000"
	);

	assert(
		generations.compare(
			"999999999999999999999999",
			"1000000000000000000000000"
		) === -1
	);

	assert(generations.compare("42", "42") === 0);

	["", "01", "-1", "1.0", "1/2", 1].forEach(function (value) {
		assert(!generations.isOrdinal(value));
	});
}

function testNamespaces() {
	assert(generations.child("10", "1") === "10/1");
	assert(generations.child("10/1", "2") === "10/1/2");

	assert(generations.localOrdinal("10/3", "10/3/7") === "7");
	assert(generations.localOrdinal("10/3", "10/3/7/1") === null);
	assert(generations.localOrdinal("10/3", "10/4/7") === null);

	throws(function () {
		generations.child("10", "0");
	}, "positive");
}

function testMissionValidation() {
	var source = mission();
	source.children.department = "10/1";

	var result = missions.validate(source);

	result.children.department = "10/2";

	assert(source.children.department === "10/1");

	source.link = "10/1";

	throws(function () {
		missions.validate(source);
	}, "Root mission");

	source.role = ["department"];

	assert(missions.validate(source).link === "10/1");

	delete source.issued;

	throws(function () {
		missions.validate(source);
	}, "Invalid mission");
}

function testIdentityAndDelegation() {
	var first = mission();
	var second = mission();

	second.issued = "1";
	second.children.department = "10/1";

	assert(
		missions.identity(first) === missions.identity(second)
	);

	assert(
		missions.delegationSignature(first) !==
			missions.delegationSignature(second)
	);

	second.link = "11";

	assert(
		missions.identity(first) !== missions.identity(second)
	);
}

function testBindingOrder() {
	var first = mission();
	var second = mission();

	first.children.a = "10/1";
	first.children.b = "10/2";

	second.children.b = "10/2";
	second.children.a = "10/1";

	assert(
		missions.delegationSignature(first) ===
			missions.delegationSignature(second)
	);
}

exports.run = function () {
	var cases = [
		["missions: normative role syntax", testRoles],
		["missions: unbounded decimal ordinals", testOrdinals],
		["missions: generation namespaces", testNamespaces],
		["missions: isolated schema validation", testMissionValidation],
		["missions: identity and delegation differ", testIdentityAndDelegation],
		["missions: binding order is insignificant", testBindingOrder]
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