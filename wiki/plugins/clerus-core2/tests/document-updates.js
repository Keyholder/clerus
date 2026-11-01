/*\
title: $:/plugins/clerus/core2/tests/document-updates.js
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

function base() {
	return {
		charter: {
			form: "charter",
			book: { instruction: "unchanged" },
			status: { phase: "initial" }
		},
		note: {
			form: "memo",
			data: { value: 1 }
		}
	};
}

function testOperationalUpdates() {
	var writes = [];
	var scope = scopes.open({
		operational: base(),

		canWriteOperational: function () {
			return true;
		},

		commitOperational: function (before, after) {
			writes.push({ before: before, after: after });
		}
	});

	try {
		var note = scope.operational.get("note");
		var input = { value: 2 };

		note.setData(input);
		input.value = 99;

		assert(scope.operational.get("note") === note);
		assert(note.data().value === 2);
		assert(writes.length === 1);
		assert(writes[0].before.note.data.value === 1);
		assert(writes[0].after.note.data.value === 2);

		// The writer does not retain access to the scope's data.
		writes[0].after.note.data.value = 88;
		assert(note.data().value === 2);

		var charter = scope.operational.get("charter");

		charter.setStatus({ phase: "running" });

		assert(charter.status().phase === "running");
		assert(charter.book().instruction === "unchanged");
		assert(writes.length === 2);
	} finally {
		scope.close();
	}
}

function testTransitUpdates() {
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

		note.setData({ value: 2 });

		var outgoing = scope.incoming.outgoing();

		scope.incoming.move("note", outgoing, "result");

		assert(outgoing.get("result") === note);
		assert(note.data().value === 2);

		note.setData({ value: 3 });

		assert(outgoing.get("result").data().value === 3);
		assert(scope.operational.get("note").data().value === 1);

		scope.assertResolved();
	} finally {
		scope.close();
	}
}

function testDeniedUpdateIsAtomic() {
	var scope = scopes.open({
		operational: base()
	});

	try {
		var note = scope.operational.get("note");

		throws(function () {
			note.setData({ value: 2 });
		}, "not writable");

		assert(note.data().value === 1);

		var outgoing = scope.operational.outgoing();

		// Copying out does not modify the operational registry.
		scope.operational.copy("note", outgoing, "copy");

		var copy = outgoing.get("copy");

		copy.setData({ value: 3 });

		assert(copy !== note);
		assert(copy.data().value === 3);
		assert(note.data().value === 1);
	} finally {
		scope.close();
	}
}

function testInvalidValueIsAtomic() {
	var writes = 0;

	var scope = scopes.open({
		operational: base(),

		canWriteOperational: function () {
			return true;
		},

		commitOperational: function () {
			writes++;
		}
	});

	try {
		var note = scope.operational.get("note");
		var before = JSON.stringify(scope.snapshot());

		throws(function () {
			note.setData({ invalid: undefined });
		});

		assert(JSON.stringify(scope.snapshot()) === before);
		assert(writes === 0);

		note.setData({ value: 4 });

		assert(note.data().value === 4);
		assert(writes === 1);
	} finally {
		scope.close();
	}
}

function testMemoCreation() {
	var writes = 0;

	var scope = scopes.open({
		operational: base(),

		canWriteOperational: function () {
			return true;
		},

		commitOperational: function () {
			writes++;
		}
	});

	try {
		var charter = scope.operational.get("charter");
		var outgoing = scope.operational.outgoing();

		var created = charter.createMemo(
			{ value: 5 },
			outgoing,
			"created"
		);

		assert(created === outgoing.get("created"));
		assert(created.data().value === 5);
		assert(writes === 0);

		var before = JSON.stringify(scope.snapshot());

		throws(function () {
			charter.createMemo(
				{ value: 6 },
				outgoing,
				"created"
			);
		}, "already exists");

		assert(JSON.stringify(scope.snapshot()) === before);

		scope.operational.move(
			"note",
			outgoing,
			"moved"
		);

		assert(writes === 1);

		charter.createMemo(
			{ value: 7 },
			scope.operational,
			"replacement"
		);

		assert(writes === 2);
		assert(
			scope.operational.get("replacement").data().value === 7
		);
	} finally {
		scope.close();
	}
}

function testNoRevival() {
	var scope = scopes.open({
		operational: base()
	});

	try {
		var outgoing = scope.operational.outgoing();

		scope.operational.copy("note", outgoing, "temporary");

		var old = outgoing.get("temporary");

		outgoing.destroy("temporary");

		throws(function () {
			old.data();
		}, "no longer available");

		scope.operational.copy("note", outgoing, "temporary");

		assert(outgoing.get("temporary") !== old);

		throws(function () {
			old.setData({ value: 99 });
		}, "no longer available");
	} finally {
		scope.close();
	}
}

function testClosedUpdates() {
	var scope = scopes.open({
		operational: base()
	});

	var charter = scope.operational.get("charter");
	var note = scope.operational.get("note");
	var operational = scope.operational;

	scope.close();

	throws(function () {
		note.setData(2);
	}, "closed");

	throws(function () {
		charter.setStatus({});
	}, "closed");

	throws(function () {
		charter.createMemo({}, operational, "new");
	}, "closed");
}

exports.run = function () {
	var cases = [
		["documents: operational updates are isolated", testOperationalUpdates],
		["documents: incoming updates permit transit", testTransitUpdates],
		["documents: denied update leaves no changes", testDeniedUpdateIsAtomic],
		["documents: invalid JSON leaves no changes", testInvalidValueIsAtomic],
		["documents: explicit memo creation", testMemoCreation],
		["documents: removed form is not revived", testNoRevival],
		["documents: closed forms cannot update", testClosedUpdates]
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