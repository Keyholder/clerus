/*\
title: $:/plugins/clerus/tests/core/warrants.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var warrants = require(
	"$:/plugins/clerus/core/warrant-schema.js"
);
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

function warrant() {
	return {
		form: "warrant",
		binding: {
			project: "Research",
			role: [],
			link: "1"
		},
		discover: [
			{
				name: "sources",
				filters: ["[tag[Source]]"]
			},
			{
				name: "notes",
				filters: ["[tag[Note]]"]
			}
		],
		generate: [],
		edit: []
	};
}

function open() {
	return scopes.open({
		operational: {
			charter: {
				form: "charter",
				status: {}
			}
		},
		incoming: {
			warrant: warrant()
		}
	});
}

function testSchema() {
	var source = warrant();

	assert(schemas.formOf(source) === "warrant");

	var normalized = warrants.validate(source);

	normalized.discover[0].filters.push("[prefix[Local/]]");

	assert(source.discover[0].filters.length === 1);

	var invalid = warrant();
	invalid.binding.extra = true;

	throws(function () {
		warrants.validate(invalid);
	}, "Unsupported warrant binding field");

	invalid = warrant();
	invalid.binding.link = null;

	throws(function () {
		warrants.validate(invalid);
	});

	invalid = warrant();
	invalid.discover.push(invalid.discover[0]);

	throws(function () {
		warrants.validate(invalid);
	}, "Duplicate warrant discovery permission");

	invalid = warrant();
	invalid.generate.push({ name: "unsupported" });

	throws(function () {
		warrants.validate(invalid);
	}, "not supported yet");

	invalid = warrant();
	invalid.edit.push({ name: "unsupported" });

	throws(function () {
		warrants.validate(invalid);
	}, "not supported yet");

	invalid = warrant();
	invalid.discover[0].filters = [];

	throws(function () {
		warrants.validate(invalid);
	}, "non-empty array");

	var unbound = warrant();
	delete unbound.binding;

	assert(
		!Object.prototype.hasOwnProperty.call(
			warrants.validate(unbound),
			"binding"
		)
	);

	invalid = warrant();
	invalid.binding.link = 1;

	throws(function () {
		warrants.validate(invalid);
	}, "Invalid mission document");
}

function testStructuralNarrowing() {
	var source = warrant();

	var result = warrants.narrow(source, {
		discover: [
			{
				name: "sources",
				filters: ["[prefix[Public/]]"]
			}
		]
	});

	assert(result.discover.length === 1);
	assert(result.discover[0].name === "sources");

	assert(
		JSON.stringify(result.discover[0].filters) ===
		JSON.stringify([
			"[tag[Source]]",
			"[prefix[Public/]]"
		])
	);

	assert(
		JSON.stringify(result.binding) ===
		JSON.stringify(source.binding)
	);

	assert(source.discover.length === 2);
	assert(source.discover[0].filters.length === 1);

	assert(
		warrants.narrow(source, { discover: [] })
			.discover.length === 0
	);

	assert(
		JSON.stringify(warrants.narrow(source, {})) ===
		JSON.stringify(source)
	);

	throws(function () {
		warrants.narrow(source, {
			discover: [{ name: "unknown" }]
		});
	}, "Unknown warrant discovery permission");

	throws(function () {
		warrants.narrow(source, {
			binding: {
				project: "Another project",
				role: [],
				link: "1"
			}
		});
	}, "Unsupported warrant restriction field");

	throws(function () {
		warrants.narrow(source, {
			discover: [
				{ name: "sources" },
				{ name: "sources" }
			]
		});
	}, "Duplicate warrant discovery restriction");
}

function testCopyAndMovement() {
	var scope = open();

	try {
		var original = scope.incoming.get("warrant");
		var outgoing = scope.incoming.outgoing();

		scope.incoming.copy("warrant", outgoing, "copy");

		var copy = outgoing.get("copy");

		assert(copy !== original);

		var declaration = copy.declaration();
		declaration.discover[0].filters.push("local");

		assert(
			copy.declaration().discover[0].filters.length === 1
		);

		scope.incoming.destroy("warrant");

		throws(function () {
			original.declaration();
		}, "no longer available");

		assert(copy.declaration().form === "warrant");
		scope.assertResolved();

		var another = outgoing.outgoing();

		outgoing.move("copy", another, "moved");

		assert(another.get("moved") === copy);

		another.destroy("moved");

		throws(function () {
			copy.declaration();
		}, "no longer available");
	} finally {
		scope.close();
	}
}

function testScopedNarrowing() {
	var scope = open();

	try {
		var original = scope.incoming.get("warrant");
		var outgoing = scope.incoming.outgoing();

		var narrowed = original.narrow({
			discover: [
				{
					name: "sources",
					filters: ["[prefix[Public/]]"]
				}
			]
		}, outgoing, "restricted");

		assert(outgoing.get("restricted") === narrowed);
		assert(narrowed !== original);
		assert(narrowed.declaration().discover.length === 1);
		assert(original.declaration().discover.length === 2);

		throws(function () {
			scope.assertResolved();
		}, "unresolved");

		scope.incoming.destroy("warrant");
		scope.assertResolved();

		assert(narrowed.declaration().binding.link === "1");
	} finally {
		scope.close();
	}
}

function testRejectedCallsAreAtomic() {
	var scope = open();

	try {
		var form = scope.incoming.get("warrant");
		var outgoing = scope.incoming.outgoing();
		var before = JSON.stringify(scope.snapshot());

		throws(function () {
			form.narrow({
				discover: [{ name: "unknown" }]
			}, outgoing, "bad");
		}, "Unknown warrant discovery permission");

		assert(JSON.stringify(scope.snapshot()) === before);

		throws(function () {
			form.narrow({}, scope.operational, "restricted");
		}, "not writable");

		assert(JSON.stringify(scope.snapshot()) === before);

		throws(function () {
			form.narrow({}, scope.incoming, "restricted");
		}, "incoming registry");

		assert(JSON.stringify(scope.snapshot()) === before);

		form.narrow({}, outgoing, "existing");
		before = JSON.stringify(scope.snapshot());

		throws(function () {
			form.narrow({}, outgoing, "existing");
		}, "already exists");

		assert(JSON.stringify(scope.snapshot()) === before);
	} finally {
		scope.close();
	}
}

function testOperationalPlacement() {
	var committed = null;

	var scope = scopes.open({
		operational: {
			charter: {
				form: "charter",
				status: {}
			}
		},
		incoming: { warrant: warrant() },

		canWriteOperational: function () {
			return true;
		},

		commitOperational: function (before, after) {
			committed = schemas.copyJSON(after);
		}
	});

	try {
		scope.incoming.get("warrant").narrow(
			{ discover: [] },
			scope.operational,
			"restricted"
		);

		assert(committed.restricted.form === "warrant");
		assert(committed.restricted.discover.length === 0);
		assert(scope.incoming.keys().length === 1);
	} finally {
		scope.close();
	}
}

function testForeignDestination() {
	var first = open();
	var second = open();

	try {
		throws(function () {
			first.incoming.get("warrant").narrow(
				{},
				second.incoming.outgoing(),
				"foreign"
			);
		}, "must belong to this scope");
	} finally {
		first.close();
		second.close();
	}
}

function testClosedAccess() {
	var scope = open();
	var form = scope.incoming.get("warrant");
	var outgoing = scope.incoming.outgoing();

	scope.close();

	throws(function () {
		form.declaration();
	}, "closed");

	throws(function () {
		form.narrow({}, outgoing, "restricted");
	}, "closed");
}

exports.run = function () {
	var cases = [
		["warrants: strict schema and isolated values", testSchema],
		["warrants: constructive discovery narrowing", testStructuralNarrowing],
		["warrants: copying and movement", testCopyAndMovement],
		["warrants: narrowing leaves the source unresolved", testScopedNarrowing],
		["warrants: rejected calls are atomic", testRejectedCallsAreAtomic],
		["warrants: operational placement is committed", testOperationalPlacement],
		["warrants: foreign destinations are rejected", testForeignDestination],
		["warrants: closed instruments provide no access", testClosedAccess]
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