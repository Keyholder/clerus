/*\
title: $:/plugins/clerus/core2/tests/contracts.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var contracts = require(
	"$:/plugins/clerus/core2/contract-schema.js"
);
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
		executor: "future-worker",
		temp: true,
		book: { instruction: "test" }
	};
}

function base() {
	return {
		charter: {
			form: "charter",
			status: {}
		}
	};
}

function testSchema() {
	assert(schemas.formOf(contract()) === "contract");

	var source = contract();
	var normalized = contracts.validate(source);

	normalized.book.instruction = "local";

	assert(source.book.instruction === "test");

	throws(function () {
		contracts.validate({
			form: "contract",
			executor: ""
		});
	}, "Invalid establishment contract");

	throws(function () {
		contracts.validate({
			form: "contract",
			executor: "worker",
			temp: "yes"
		});
	}, "temp must be boolean");
}

function testReadingAndMovement() {
	var scope = scopes.open({
		operational: base(),
		incoming: { contract: contract() }
	});

	try {
		var form = scope.incoming.get("contract");

		assert(form.executor() === "future-worker");
		assert(form.temp() === true);

		var book = form.book();
		book.instruction = "local";

		assert(form.book().instruction === "test");

		var outgoing = scope.incoming.outgoing();

		scope.incoming.move(
			"contract",
			outgoing,
			"contract"
		);

		assert(outgoing.get("contract") === form);
		assert(scope.incoming.keys().length === 0);
		scope.assertResolved();

		var snapshot = scope.snapshot();

		assert(snapshot.outgoing[0].contract.form === "contract");
		assert(Object.keys(snapshot.operational).join(",") === "charter");
	} finally {
		scope.close();
	}
}

function testCopyIsRejectedAtomically() {
	var scope = scopes.open({
		operational: base(),
		incoming: { contract: contract() }
	});

	try {
		var outgoing = scope.incoming.outgoing();
		var before = JSON.stringify(scope.snapshot());

		throws(function () {
			scope.incoming.copy(
				"contract",
				outgoing,
				"copy"
			);
		}, "cannot be copied");

		assert(JSON.stringify(scope.snapshot()) === before);
	} finally {
		scope.close();
	}
}

function testOperationalPlacementRequiresPermission() {
	var scope = scopes.open({
		operational: base(),
		incoming: { contract: contract() }
	});

	try {
		var form = scope.incoming.get("contract");

		throws(function () {
			scope.incoming.move(
				"contract",
				scope.operational,
				"contract"
			);
		}, "not writable");

		assert(scope.incoming.get("contract") === form);
		assert(scope.incoming.keys().length === 1);
		assert(scope.operational.keys().length === 1);
	} finally {
		scope.close();
	}
}

function testEqualSerializationsRemainSeparate() {
	var document = contract();

	var scope = scopes.open({
		operational: base(),
		incoming: {
			first: document,
			second: document
		}
	});

	try {
		var first = scope.incoming.get("first");
		var second = scope.incoming.get("second");

		assert(first !== second);

		scope.incoming.destroy("first");

		throws(function () {
			first.executor();
		}, "no longer available");

		assert(second.executor() === "future-worker");

		scope.incoming.destroy("second");
		scope.assertResolved();
	} finally {
		scope.close();
	}
}

function testClosedAccess() {
	var scope = scopes.open({
		operational: base(),
		incoming: { contract: contract() }
	});

	var form = scope.incoming.get("contract");

	scope.close();

	throws(function () {
		form.book();
	}, "closed");
}

exports.run = function () {
	var cases = [
		["contracts: schema and isolated values", testSchema],
		["contracts: explicit movement preserves the form", testReadingAndMovement],
		["contracts: copying is rejected atomically", testCopyIsRejectedAtomically],
		["contracts: operational placement requires permission", testOperationalPlacementRequiresPermission],
		["contracts: equal serializations remain separate", testEqualSerializationsRemainSeparate],
		["contracts: closed form provides no access", testClosedAccess]
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