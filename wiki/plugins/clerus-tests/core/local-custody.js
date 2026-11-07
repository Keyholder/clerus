/*\
title: $:/plugins/clerus/tests/core/local-custody.js
type: application/javascript
module-type: library
\*/

"use strict";

var localCustody = require(
	"$:/plugins/clerus/core/local-custody.js"
);

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function testOnlyOwnAssignment(tw) {
	var platform = tw.browser ? "browser" : "node";
	var other = platform === "browser" ? "node" : "browser";
	var custody = localCustody.create({
		platform: platform
	});

	assert(custody.owns({
		title: "Ordinary",
		"clerus-custody": platform
	}));

	assert(!custody.owns({
		title: "Ordinary",
		"clerus-custody": other
	}));

	assert(!custody.owns({
		title: "Ordinary",
		"clerus-custody": "user"
	}));

	assert(!custody.owns({
		title: "Ordinary"
	}));
}

function testOwnershipDoesNotValidateJobState(tw) {
	var platform = tw.browser ? "browser" : "node";
	var custody = localCustody.create({
		platform: platform
	});

	assert(custody.owns({
		title: "$:/clerus/jobs/damaged",
		"clerus-custody": platform,
		text: "{broken"
	}));

	/*
		Ownership is not execution readiness or document validity.
	*/
	assert(custody.owns({
		title: "$:/clerus/jobs/no-executor",
		"clerus-custody": platform
	}));
}

function testNoCachedDecision(tw) {
	var platform = tw.browser ? "browser" : "node";
	var custody = localCustody.create({
		platform: platform
	});

	var fields = {
		title: "Ordinary",
		"clerus-custody": platform
	};

	assert(custody.owns(fields));

	fields["clerus-custody"] = "user";

	assert(!custody.owns(fields));
}

function testPlatformIsCaptured(tw) {
	var platform = tw.browser ? "browser" : "node";
	var options = { platform: platform };
	var custody = localCustody.create(options);

	options.platform = platform === "browser" ? "node" : "browser";

	assert(custody.owns({
		title: "Ordinary",
		"clerus-custody": platform
	}));

	assert(Object.isFrozen(custody));
	assert(Object.keys(custody).join(",") === "owns");
}

exports.run = function (tw) {
	var cases = [
		["only own assignment is recognized", testOnlyOwnAssignment],
		["ownership does not imply valid job state", testOwnershipDoesNotValidateJobState],
		["decisions are not cached across snapshots", testNoCachedDecision],
		["service captures only its local platform", testPlatformIsCaptured]
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