/*\
title: $:/plugins/clerus/core/tests/planned-defer.js
type: application/javascript
module-type: library
\*/

"use strict";

var Plan = require("$:/plugins/clerus/core/plan.js").Plan;
var effects = require(
	"$:/plugins/clerus/core/deferred-effect.js"
);
var proposals = require(
	"$:/plugins/clerus/core/proposal-schema.js"
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

function plan() {
	return new Plan({
		materialized: [],
		shadows: []
	});
}

function effect() {
	return {
		version: 1,
		kind: "deferred-event",
		id: "planned-defer-event-0001",
		platform: "browser",

		recipient: {
			title: "$:/clerus/jobs/planned-defer-owner",
			executor: "owner"
		}
	};
}

function testRepeatedRequestsCoalesce() {
	var root = plan();
	var first = effect();
	var second = effect();

	second.id = "planned-defer-event-0002";

	assert(root.defer(first) === "recorded");
	assert(root.defer(second) === "already-recorded");

	var compiled = root.export();

	assert(compiled.deferred.length === 1);
	assert(compiled.deferred[0].id === first.id);

	first.recipient.executor = "local mutation";

	assert(
		root.export().deferred[0].recipient.executor === "owner"
	);
}

function testFailedOperationDiscardsRequest() {
	var root = plan();

	throws(function () {
		root.transact(function (branch) {
			branch.defer(effect());
			throw new Error("Rejected defer operation");
		});
	}, "Rejected defer operation");

	assert(root.export().deferred.length === 0);

	root.transact(function (branch) {
		branch.defer(effect());
	});

	assert(root.export().deferred.length === 1);
}

function testRecipientCannotChange() {
	var root = plan();

	root.defer(effect());

	var changed = effect();
	changed.recipient.executor = "replacement";

	throws(function () {
		root.defer(changed);
	}, "recipient changed");

	assert(root.export().deferred.length === 1);
}

function testEffectRequiresPersistentRecipient() {
	var value = effect();

	value.recipient.title =
		"$:/temp/clerus/jobs/browser/ephemeral";

	throws(function () {
		effects.validate(value);
	}, "Invalid persistent deferred effect");
}

function testAcceptanceRemainsExplicitlyClosed() {
	var value = effect();

	var proposal = {
		version: 1,
		owner: {
			title: value.recipient.title,
			executor: value.recipient.executor,

			state: {
				title: value.recipient.title,
				type: "application/json",
				"clerus-custody": "browser",
				"clerus-executor": value.recipient.executor,
				text: JSON.stringify({
					charter: { form: "charter", status: {} }
				})
			}
		},
		plan: {
			version: 1,
			effects: [],
			messages: [],
			deferred: [value]
		}
	};

	throws(function () {
		proposals.validate(proposal);
	}, "requires deferred-obligation support");

	var normalized = proposals.validate(proposal, {
		allowDeferred: true
	});

	assert(normalized.plan.deferred.length === 1);
}

function testSealRetainsRequest() {
	var root = plan();

	root.defer(effect());

	var compiled = root.seal();

	assert(compiled.deferred.length === 1);

	compiled.deferred[0].recipient.executor = "local";

	assert(
		root.export().deferred[0].recipient.executor === "owner"
	);
}

exports.run = function () {
	var cases = [
		["planned defer: repeated requests coalesce", testRepeatedRequestsCoalesce],
		["planned defer: operation failure discards the request", testFailedOperationDiscardsRequest],
		["planned defer: recipient identity cannot change", testRecipientCannotChange],
		["planned defer: effect requires a persistent recipient", testEffectRequiresPersistentRecipient],
		["planned defer: unsupported acceptance does not swallow the request", testAcceptanceRemainsExplicitlyClosed],
		["planned defer: sealed export retains the request", testSealRetainsRequest]
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