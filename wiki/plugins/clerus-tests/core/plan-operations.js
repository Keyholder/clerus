/*\
title: $:/plugins/clerus/tests/core/plan-operations.js
type: application/javascript
module-type: library
\*/

"use strict";

var Plan = require("$:/plugins/clerus/core/plan.js").Plan;
var stores = require("$:/plugins/clerus/core/store.js");

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
		materialized: [
			{ title: "First", text: "initial first" },
			{ title: "Second", text: "initial second" }
		],
		shadows: []
	});
}

function put(target, title, text) {
	target.apply(stores.transition(
		title,
		target.read(title).fields,
		{ title: title, text: text }
	));
}

function testSuccessfulOperation() {
	var root = plan();
	var saved;

	var result = root.transact(function (branch) {
		saved = branch;

		put(branch, "First", "updated first");
		put(branch, "Second", "updated second");

		assert(root.read("First").fields.text === "initial first");
		assert(root.read("Second").fields.text === "initial second");

		return { value: 42 };
	});

	assert(result.value === 42);
	assert(root.read("First").fields.text === "updated first");
	assert(root.read("Second").fields.text === "updated second");
	assert(root.export().effects.length === 2);

	assert(saved.state === "accepted");

	throws(function () {
		saved.read("First");
	}, "not open");
}

function testFailureLeavesNoPartialEffect() {
	var root = plan();
	var before = JSON.stringify(root.export());
	var saved;

	throws(function () {
		root.transact(function (branch) {
			saved = branch;

			put(branch, "First", "must be discarded");

			branch.apply(stores.transition(
				"Second",
				{ title: "Second", text: "wrong baseline" },
				{ title: "Second", text: "forbidden" }
			));
		});
	}, "conflict");

	assert(JSON.stringify(root.export()) === before);
	assert(root.read("First").fields.text === "initial first");
	assert(root.read("Second").fields.text === "initial second");
	assert(saved.state === "aborted");

	// A caught operation failure does not prevent later work.
	root.transact(function (branch) {
		put(branch, "Second", "allowed");
	});

	assert(root.read("Second").fields.text === "allowed");
	assert(root.export().effects.length === 1);
}

function testStaleBranchCannotOverwriteParent() {
	var root = plan();
	var branch = root.fork();

	put(branch, "First", "branch change");
	put(root, "Second", "parent change");

	throws(function () {
		root.accept(branch);
	}, "stale");

	assert(root.read("First").fields.text === "initial first");
	assert(root.read("Second").fields.text === "parent change");

	branch.abort();
}

function testForeignBranchIsRejected() {
	var first = plan();
	var second = plan();
	var branch = first.fork();

	put(branch, "First", "branch change");

	throws(function () {
		second.accept(branch);
	}, "another parent");

	assert(second.export().effects.length === 0);
	assert(first.export().effects.length === 0);

	branch.abort();
}

function testNestedOperations() {
	var root = plan();

	root.transact(function (outer) {
		put(outer, "First", "outer");

		throws(function () {
			outer.transact(function (inner) {
				put(inner, "Second", "discarded");
				throw new Error("Inner failure");
			});
		}, "Inner failure");

		assert(outer.read("First").fields.text === "outer");
		assert(outer.read("Second").fields.text === "initial second");

		outer.transact(function (inner) {
			put(inner, "Second", "accepted inner");
		});
	});

	assert(root.read("First").fields.text === "outer");
	assert(root.read("Second").fields.text === "accepted inner");
}

function testAsyncPreparationIsRejected() {
	var root = plan();
	var saved;

	throws(function () {
		root.transact(function (branch) {
			saved = branch;

			put(branch, "First", "discarded");

			return Promise.resolve();
		});
	}, "must be synchronous");

	assert(root.export().effects.length === 0);

	throws(function () {
		put(saved, "First", "late continuation");
	}, "not open");
}

function testParentClosureRevokesBranch() {
	var root = plan();
	var branch = root.fork();

	root.abort();

	throws(function () {
		branch.read("First");
	}, "not open");

	branch.abort();

	assert(branch.state === "aborted");
}

function testBranchCannotSeal() {
	var root = plan();
	var branch = root.fork();

	throws(function () {
		branch.seal();
	}, "must be accepted");

	assert(root.export().effects.length === 0);

	branch.abort();
}

function testFoldingAcrossOperations() {
	var root = plan();

	root.transact(function (branch) {
		put(branch, "First", "temporary");
	});

	root.transact(function (branch) {
		put(branch, "First", "initial first");
	});

	assert(root.export().effects.length === 0);
}

exports.run = function () {
	var cases = [
		["plan operations: successful proposal is accepted as a whole", testSuccessfulOperation],
		["plan operations: failure leaves no partial effect", testFailureLeavesNoPartialEffect],
		["plan operations: stale branch cannot overwrite parent", testStaleBranchCannotOverwriteParent],
		["plan operations: foreign branch is rejected", testForeignBranchIsRejected],
		["plan operations: nested proposals remain isolated", testNestedOperations],
		["plan operations: asynchronous preparation is rejected", testAsyncPreparationIsRejected],
		["plan operations: closing parent revokes branch access", testParentClosureRevokesBranch],
		["plan operations: branch cannot be sealed independently", testBranchCannotSeal],
		["plan operations: effects fold across accepted operations", testFoldingAcrossOperations]
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