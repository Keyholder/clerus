/*\
title: $:/plugins/clerus/tests/core/scope.js
type: application/javascript
module-type: library
\*/

"use strict";

var scopes = require("$:/plugins/clerus/core/scope.js");
var Store = require("$:/plugins/clerus/core/store.js").Store;

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

function charter() {
	return {
		form: "charter",
		book: { instruction: "test" },
		status: { phase: "initial" }
	};
}

function testCopies() {
	var initial = {
		charter: charter(),
		note: {
			form: "memo",
			data: { value: 1 }
		}
	};

	var scope = scopes.open({
		operational: initial
	});

	try {
		initial.note.data.value = 99;

		var note = scope.operational.get("note");
		var first = note.data();

		assert(first.value === 1);

		first.value = 42;

		assert(note.data().value === 1);

		var instruction =
			scope.operational.get("charter").book();

		instruction.instruction = "changed";

		assert(
			scope.operational.get("charter")
				.book().instruction === "test"
		);

		var keys = scope.operational.keys();
		keys.length = 0;

		assert(scope.operational.keys().length === 2);
	} finally {
		scope.close();
	}
}

function testTitleSharing() {
	var scope = scopes.open({
		operational: {
			charter: charter(),
			first: "Shared Title",
			second: "Shared Title"
		},
		incoming: {
			first: "Shared Title"
		}
	});

	try {
		var form = scope.operational.get("first");

		assert(form === scope.operational.get("first"));
		assert(form === scope.operational.get("second"));
		assert(form === scope.incoming.get("first"));

		assert(
			scope.operational.keys().length === 3 &&
				scope.incoming.keys().length === 1,
			"Sharing forms merged registry entries"
		);
	} finally {
		scope.close();
	}
}

function testMemoSeparation() {
	var shared = {
		form: "memo",
		data: { value: 1 }
	};

	var scope = scopes.open({
		operational: {
			charter: charter(),
			first: shared,
			second: shared
		},
		incoming: {
			first: shared
		}
	});

	try {
		var first = scope.operational.get("first");
		var second = scope.operational.get("second");
		var incoming = scope.incoming.get("first");

		assert(first !== second);
		assert(first !== incoming);
		assert(second !== incoming);

		assert(first.data().value === 1);
		assert(second.data().value === 1);
		assert(incoming.data().value === 1);
	} finally {
		scope.close();
	}
}

function testTitleReading(tw) {
	var wiki = new tw.Wiki();
	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var title = "Core2 Scope Target";

	var scope = scopes.open({
		operational: {
			charter: charter(),
			document: title
		},
		readTiddler: store.read.bind(store)
	});

	try {
		var document = scope.operational.get("document");

		assert(document.inspect().kind === "absent");

		throws(function () {
			document.text();
		}, "does not exist");

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			text: "created",
			caption: "Caption"
		}));

		assert(document.text() === "created");
		assert(document.field("caption") === "Caption");
		assert(document.field("missing") === undefined);

		var view = document.inspect();

		view.fields.text = "local mutation";

		assert(document.text() === "created");
		assert(wiki.getTiddlerText(title) === "created");

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			text: "updated"
		}));

		assert(document.text() === "updated");

		wiki.deleteTiddler(title);

		assert(document.inspect().kind === "absent");
	} finally {
		scope.close();
	}
}

function testSafeKeys() {
	var scope = scopes.open({
		operational: {
			charter: charter()
		},
		incoming: JSON.parse(
			'{"__proto__":{"form":"memo","data":{"value":1}}}'
		)
	});

	try {
		assert(
			scope.incoming.get("__proto__").data().value === 1
		);

		throws(function () {
			scope.incoming.get("constructor");
		}, "Unknown document key");
	} finally {
		scope.close();
	}
}

function testClosure() {
	var scope = scopes.open({
		operational: {
			charter: charter(),
			note: {
				form: "memo",
				data: { value: 1 }
			},
			document: "Closed Scope Target"
		},
		incoming: {}
	});

	var note = scope.operational.get("note");
	var charterForm = scope.operational.get("charter");
	var title = scope.operational.get("document");

	scope.close();
	scope.close();

	throws(function () {
		scope.operational.keys();
	}, "closed");

	throws(function () {
		scope.incoming.keys();
	}, "closed");

	throws(function () {
		scope.operational.get("note");
	}, "closed");

	throws(function () {
		note.data();
	}, "closed");

	throws(function () {
		charterForm.status();
	}, "closed");

	throws(function () {
		title.inspect();
	}, "closed");
}

exports.run = function (tw) {
	var cases = [
		["scope: isolated reads", testCopies],
		["scope: titles share access across registries", testTitleSharing],
		["scope: equal memos remain separate", testMemoSeparation],
		["scope: current tiddler reads", function () {
			testTitleReading(tw);
		}],
		["scope: safe registry keys", testSafeKeys],
		["scope: access expires on closure", testClosure]
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