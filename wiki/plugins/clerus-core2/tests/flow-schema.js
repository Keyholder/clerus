/*\
title: $:/plugins/clerus/core2/tests/flow-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var flows = require("$:/plugins/clerus/core2/flow-schema.js");
var messages = require("$:/plugins/clerus/core2/message-effect.js");
var proposals = require("$:/plugins/clerus/core2/proposal-schema.js");

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

function message() {
	return {
		version: 1,
		kind: "official-message",
		id: "flow-schema-message-0001",
		platform: "browser",
		type: "order",
		source: {
			title: "$:/clerus/jobs/flow-schema-source",
			executor: "source"
		},
		recipient: {
			title: "$:/clerus/jobs/flow-schema-recipient",
			executor: "recipient"
		},
		registry: {
			note: { form: "memo", data: 42 }
		}
	};
}

function proposal() {
	var outgoing = message();

	return {
		version: 1,
		owner: {
			title: outgoing.source.title,
			executor: outgoing.source.executor,
			state: {
				title: outgoing.source.title,
				type: "application/json",
				"clerus-custody": "browser",
				"clerus-executor": outgoing.source.executor,
				text: JSON.stringify({
					charter: { form: "charter", status: {} }
				})
			}
		},
		plan: {
			version: 1,
			effects: [],
			messages: [outgoing]
		}
	};
}

function record() {
	return {
		version: 1,
		kind: "flow",
		platform: "browser",
		active: null,
		pending: [],
		seen: {},
		errors: []
	};
}

function testActiveProposal() {
	var source = record();
	source.active = proposal();

	var normalized = flows.validate(source, "browser");

	assert(normalized.active.plan.messages.length === 1);
	assert(normalized.pending.length === 0);

	normalized.active.plan.messages[0].registry.note.data = 99;

	assert(source.active.plan.messages[0].registry.note.data === 42);
}

function testPendingIdentity() {
	var source = record();
	var outgoing = message();

	source.pending.push(outgoing);
	source.seen[outgoing.id] = messages.fingerprint(outgoing);

	assert(flows.validate(source, "browser").pending.length === 1);

	source.pending[0].registry.note.data = 99;

	throws(function () {
		flows.validate(source, "browser");
	}, "not registered");
}

function testHistoryDoesNotBecomePending() {
	var source = record();
	var outgoing = message();

	source.seen[outgoing.id] = messages.fingerprint(outgoing);

	var normalized = flows.validate(source, "browser");

	assert(normalized.active === null);
	assert(normalized.pending.length === 0);
	assert(Object.keys(normalized.seen).length === 1);
}

function testActiveIdentityConflict() {
	var source = record();
	var outgoing = message();

	source.seen[outgoing.id] = messages.fingerprint(outgoing);
	source.active = proposal();
	source.active.plan.messages[0].registry.note.data = 99;

	throws(function () {
		flows.validate(source, "browser");
	}, "identity was reused");
}

function testOrdinaryWalStillRejectsMessages() {
	throws(function () {
		proposals.validate(proposal());
	}, "requires a transactional flow");

	assert(
		proposals.validate(proposal(), {
			allowMessages: true
		}).plan.messages.length === 1
	);
}

function testUnsupportedBranchErrors() {
	var source = record();
	source.errors.push({ error: "invalid" });

	throws(function () {
		flows.validate(source, "browser");
	}, "branch diagnostic");
}

exports.run = function () {
	var cases = [
		["flow schema: active proposal is isolated", testActiveProposal],
		["flow schema: pending identity must match history", testPendingIdentity],
		["flow schema: history does not create pending work", testHistoryDoesNotBecomePending],
		["flow schema: conflicting identity is rejected", testActiveIdentityConflict],
		["flow schema: ordinary WAL does not swallow messages", testOrdinaryWalStillRejectsMessages],
		["flow schema: malformed branch diagnostic is rejected", testUnsupportedBranchErrors]
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