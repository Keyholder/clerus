/*\
title: $:/plugins/clerus/core2/tests/establishment-scope.js
type: application/javascript
module-type: library
\*/

"use strict";

var scopes = require("$:/plugins/clerus/core2/scope.js");

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

function contract() {
	return {
		form: "contract",
		executor: "new-worker",
		temp: true,
		book: { instruction: "test" }
	};
}

function testExplicitAcceptance() {
	var created = null;

	var scope = scopes.open({
		operational: null,

		incoming: {
			contract: contract(),
			note: { form: "memo", data: 42 }
		},

		establishOperational: function (registry) {
			created = registry;
		}
	});

	try {
		assert(scope.snapshot().operational === null);

		throws(function () {
			scope.operational.keys();
		}, "not established");

		var mandate = scope.incoming.get("contract");
		var charter = mandate.accept(
			"charter",
			{ phase: "starting" }
		);

		assert(charter === scope.operational.get("charter"));
		assert(charter.book().instruction === "test");
		assert(charter.status().phase === "starting");

		assert(created.charter.form === "charter");
		assert(created.charter.status.phase === "starting");
		assert(scope.incoming.keys().join(",") === "note");

		created.charter.status.phase = "external mutation";

		assert(charter.status().phase === "starting");

		throws(function () {
			mandate.executor();
		}, "no longer available");

		throws(function () {
			scope.assertResolved();
		}, "unresolved");

		scope.incoming.destroy("note");
		scope.assertResolved();
	} finally {
		scope.close();
	}
}

function testInvalidStatusIsAtomic() {
	var creations = 0;

	var scope = scopes.open({
		operational: null,
		incoming: { contract: contract() },

		establishOperational: function () {
			creations++;
		}
	});

	try {
		var mandate = scope.incoming.get("contract");

		throws(function () {
			mandate.accept("charter", undefined);
		});

		assert(creations === 0);
		assert(scope.snapshot().operational === null);
		assert(scope.incoming.get("contract") === mandate);

		mandate.accept("charter", {});

		assert(creations === 1);
		scope.assertResolved();
	} finally {
		scope.close();
	}
}

function testDiscardingContractDoesNotEstablish() {
	var scope = scopes.open({
		operational: null,
		incoming: { contract: contract() }
	});

	try {
		scope.incoming.destroy("contract");

		assert(scope.incoming.keys().length === 0);
		assert(scope.snapshot().operational === null);

		throws(function () {
			scope.assertResolved();
		}, "was not accepted");
	} finally {
		scope.close();
	}
}

function testExactlyOneContract() {
	[{}, {
		first: contract(),
		second: contract()
	}].forEach(function (incoming) {
		throws(function () {
			scopes.open({
				operational: null,
				incoming: incoming
			});
		}, "exactly one");
	});
}

function testMaterializationFailureClosesScope() {
	var scope = scopes.open({
		operational: null,
		incoming: { contract: contract() },

		establishOperational: function () {
			throw new Error("Injected birth failure");
		}
	});

	var mandate = scope.incoming.get("contract");

	throws(function () {
		mandate.accept("charter", {});
	}, "Injected birth failure");

	throws(function () {
		mandate.executor();
	}, "closed");
}

function testExistingJobCannotAccept() {
	var scope = scopes.open({
		operational: {
			charter: { form: "charter", status: {} }
		},
		incoming: { contract: contract() }
	});

	try {
		throws(function () {
			scope.incoming.get("contract").accept("another", {});
		}, "cannot establish this scope");

		assert(scope.operational.keys().join(",") === "charter");
		assert(scope.incoming.keys().join(",") === "contract");
	} finally {
		scope.close();
	}
}

exports.run = function () {
	var cases = [
		["establishment scope: explicit contract acceptance", testExplicitAcceptance],
		["establishment scope: invalid status leaves contract intact", testInvalidStatusIsAtomic],
		["establishment scope: discarding is not acceptance", testDiscardingContractDoesNotEstablish],
		["establishment scope: exactly one incoming contract", testExactlyOneContract],
		["establishment scope: birth failure closes access", testMaterializationFailureClosesScope],
		["establishment scope: existing job cannot be reestablished", testExistingJobCannotAccept]
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