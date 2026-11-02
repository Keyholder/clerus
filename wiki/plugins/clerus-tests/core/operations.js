/*\
title: $:/plugins/clerus/tests/core/operations.js
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

function base() {
	return {
		charter: {
			form: "charter",
			status: {}
		}
	};
}

function testTransit() {
	var scope = scopes.open({
		operational: base(),
		incoming: {
			note: {
				form: "memo",
				data: { value: 1 }
			}
		}
	});

	try {
		var note = scope.incoming.get("note");
		var outgoing = scope.incoming.outgoing();

		scope.incoming.move("note", outgoing, "result");

		assert(outgoing.get("result") === note);
		assert(note.data().value === 1);
		assert(scope.incoming.keys().length === 0);
		assert(scope.operational.keys().length === 1);

		scope.assertResolved();
	} finally {
		scope.close();
	}
}

function testCopyDoesNotConsume() {
	var scope = scopes.open({
		operational: base(),
		incoming: {
			note: {
				form: "memo",
				data: { value: 1 }
			}
		}
	});

	try {
		var outgoing = scope.incoming.outgoing();

		scope.incoming.copy("note", outgoing, "copy");

		assert(
			outgoing.get("copy") !== scope.incoming.get("note")
		);

		throws(function () {
			scope.assertResolved();
		}, "unresolved");

		scope.incoming.destroy("note");
		scope.assertResolved();

		assert(outgoing.get("copy").data().value === 1);
	} finally {
		scope.close();
	}
}

function testAtomicRefusal() {
	var writes = 0;

	var scope = scopes.open({
		operational: base(),
		incoming: {
			note: { form: "memo", data: 1 }
		},
		canWriteOperational: function () {
			return true;
		},
		commitOperational: function () {
			writes++;
		}
	});

	try {
		var before = JSON.stringify(scope.snapshot());

		throws(function () {
			scope.incoming.move(
				"note",
				scope.operational,
				"charter"
			);
		}, "already exists");

		assert(JSON.stringify(scope.snapshot()) === before);
		assert(writes === 0);

		scope.incoming.move("note", scope.operational, "note");

		assert(writes === 1);
		assert(scope.operational.get("note").data() === 1);
		scope.assertResolved();
	} finally {
		scope.close();
	}
}

function testDeniedWritePreservesScope() {
	var scope = scopes.open({
		operational: base(),
		incoming: {
			note: { form: "memo", data: 1 }
		}
	});

	try {
		throws(function () {
			scope.incoming.move(
				"note",
				scope.operational,
				"note"
			);
		}, "not writable");

		assert(scope.incoming.get("note").data() === 1);

		var outgoing = scope.incoming.outgoing();

		scope.incoming.move("note", outgoing, "note");
		scope.assertResolved();
	} finally {
		scope.close();
	}
}

function testLastTitleRevokesAccess() {
	var scope = scopes.open({
		operational: base(),
		incoming: {
			first: "Shared Title",
			second: "Shared Title"
		},
		readTiddler: function () {
			return { kind: "absent", fields: null };
		}
	});

	try {
		var title = scope.incoming.get("first");

		assert(title === scope.incoming.get("second"));

		scope.incoming.destroy("first");

		assert(title.inspect().kind === "absent");

		scope.incoming.destroy("second");

		throws(function () {
			title.inspect();
		}, "no longer available");
	} finally {
		scope.close();
	}
}

function testCharterProtection() {
	var scope = scopes.open({
		operational: base(),
		canWriteOperational: function () {
			return true;
		},
		commitOperational: function () {
			throw new Error("Writer must not be reached");
		}
	});

	try {
		var outgoing = scope.operational.outgoing();

		throws(function () {
			scope.operational.copy("charter", outgoing, "charter");
		}, "cannot be copied");

		throws(function () {
			scope.operational.move("charter", outgoing, "charter");
		}, "cannot be copied");

		throws(function () {
			scope.operational.destroy("charter");
		}, "cannot be destroyed");
	} finally {
		scope.close();
	}
}

function testForeignRegistry() {
	var first = scopes.open({
		operational: base(),
		incoming: {
			note: { form: "memo", data: 1 }
		}
	});

	var second = scopes.open({
		operational: base()
	});

	try {
		throws(function () {
			first.incoming.move(
				"note",
				second.operational,
				"note"
			);
		}, "belong to this scope");

		assert(first.incoming.get("note").data() === 1);
	} finally {
		first.close();
		second.close();
	}
}

function testMaterialFailureClosesScope() {
	var scope = scopes.open({
		operational: base(),
		incoming: {
			note: { form: "memo", data: 1 }
		},
		canWriteOperational: function () {
			return true;
		},
		commitOperational: function () {
			throw new Error("Injected write failure");
		}
	});

	throws(function () {
		scope.incoming.move("note", scope.operational, "note");
	}, "Injected write failure");

	throws(function () {
		scope.incoming.keys();
	}, "closed");

	scope.close();
}

exports.run = function () {
	var cases = [
		["operations: transit without operational writes", testTransit],
		["operations: copying does not consume input", testCopyDoesNotConsume],
		["operations: refusal is atomic", testAtomicRefusal],
		["operations: denied write permits later transit", testDeniedWritePreservesScope],
		["operations: last title removal revokes access", testLastTitleRevokesAccess],
		["operations: charter protection", testCharterProtection],
		["operations: foreign registry is rejected", testForeignRegistry],
		["operations: material failure closes scope", testMaterialFailureClosesScope]
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