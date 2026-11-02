/*\
title: $:/plugins/clerus/tests/core/planned-messages.js
type: application/javascript
module-type: library
\*/

"use strict";

var Plan = require("$:/plugins/clerus/core/plan.js").Plan;
var effects = require(
	"$:/plugins/clerus/core/message-effect.js"
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

function message() {
	return {
		version: 1,
		kind: "official-message",
		id: "planned-message-0001",
		platform: "browser",
		type: "order",
		source: {
			title: "$:/clerus/jobs/message-source",
			executor: "source"
		},
		recipient: {
			title: "$:/clerus/jobs/message-recipient",
			executor: "recipient"
		},
		registry: {
			note: {
				form: "memo",
				data: { first: 1, second: 2 }
			}
		}
	};
}

function testStableIdentity() {
	var root = plan();
	var source = message();

	assert(root.send(source) === "recorded");
	assert(root.send(source) === "already-recorded");

	source.registry.note.data.first = 99;

	assert(
		root.export().messages[0].registry.note.data.first === 1
	);

	throws(function () {
		root.send(source);
	}, "identity was reused");

	assert(root.export().messages.length === 1);
}

function testObjectOrderDoesNotChangeIdentity() {
	var first = message();
	var second = message();

	second.registry.note.data = {
		second: 2,
		first: 1
	};

	assert(
		effects.fingerprint(first) ===
			effects.fingerprint(second)
	);

	var root = plan();

	root.send(first);

	assert(root.send(second) === "already-recorded");
}

function testOperationAbortDiscardsMessage() {
	var root = plan();

	throws(function () {
		root.transact(function (branch) {
			branch.send(message());
			throw new Error("Rejected send operation");
		});
	}, "Rejected send operation");

	assert(root.export().messages.length === 0);

	root.transact(function (branch) {
		branch.send(message());
	});

	assert(root.export().messages.length === 1);
}

function testConcurrentBranchesCannotLoseMessages() {
	var root = plan();
	var branch = root.fork();

	branch.send(message());

	var another = message();
	another.id = "planned-message-0002";

	root.send(another);

	throws(function () {
		root.accept(branch);
	}, "stale");

	assert(root.export().messages.length === 1);
	assert(root.export().messages[0].id === another.id);

	branch.abort();
}

function testSealedExportIsIsolated() {
	var root = plan();

	root.send(message());

	var compiled = root.seal();

	assert(compiled.effects.length === 0);
	assert(compiled.messages.length === 1);

	compiled.messages[0].recipient.executor = "local";

	assert(
		root.export().messages[0].recipient.executor === "recipient"
	);

	throws(function () {
		root.send(message());
	}, "not open");
}

function testEnvelopeBoundaries() {
	var report = message();

	report.type = "report";

	throws(function () {
		effects.validate(report);
	}, "non-root role");

	report.project = "Message Project";
	report.role = ["item"];

	assert(effects.validate(report).role[0] === "item");

	var foreign = message();
	foreign.recipient.title =
		"$:/temp/clerus/jobs/node/foreign";

	throws(function () {
		effects.validate(foreign);
	}, "another platform");

	var establishing = message();
	establishing.establishing = true;

	throws(function () {
		effects.validate(establishing);
	}, "exactly one contract");
}

exports.run = function () {
	var cases = [
		["planned messages: stable identity and isolated payload", testStableIdentity],
		["planned messages: object key order is insignificant", testObjectOrderDoesNotChangeIdentity],
		["planned messages: operation abort discards sending", testOperationAbortDiscardsMessage],
		["planned messages: stale branch cannot lose accepted messages", testConcurrentBranchesCannotLoseMessages],
		["planned messages: sealed export is isolated", testSealedExportIsIsolated],
		["planned messages: envelope boundaries are checked", testEnvelopeBoundaries]
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