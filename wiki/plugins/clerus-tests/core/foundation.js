/*\
title: $:/plugins/clerus/tests/core/foundation.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
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

function charter() {
	return {
		form: "charter",
		status: {}
	};
}

function testRegistries() {
	[null, [], true, 1, "text"].forEach(function (value) {
		throws(function () {
			schemas.registry(value, "operational");
		});
	});

	throws(function () {
		schemas.registry({}, "operational");
	}, "exactly one charter");

	throws(function () {
		schemas.registry({
			first: charter(),
			second: charter()
		}, "operational");
	}, "exactly one charter");

	throws(function () {
		schemas.registry({
			charter: charter()
		}, "incoming");
	}, "cannot contain a charter");

	throws(function () {
		schemas.document({ form: "memo" });
	}, "must contain data");

	var source = {
		charter: charter(),
		note: {
			form: "memo",
			data: { value: 1 }
		}
	};

	var result = schemas.registry(source, "operational");

	result.note.data.value = 2;

	assert(source.note.data.value === 1, "Validation leaked a reference");

	var safe = schemas.registry(JSON.parse(
		'{"__proto__":{"form":"memo","data":{"value":1}}}'
	), "incoming");

	assert(Object.getPrototypeOf(safe) === null);
	assert(Object.prototype.hasOwnProperty.call(safe, "__proto__"));
	assert(safe.__proto__.data.value === 1);
}

function testJSONBoundary() {
	var invoked = false;
	var accessor = {};

	Object.defineProperty(accessor, "value", {
		enumerable: true,
		get: function () {
			invoked = true;
			return 1;
		}
	});

	throws(function () {
		schemas.copyJSON(accessor);
	});

	assert(!invoked, "Validation invoked an accessor");

	var cycle = {};
	cycle.self = cycle;

	throws(function () {
		schemas.copyJSON(cycle);
	}, "cycles");

	throws(function () {
		schemas.copyJSON({ value: undefined });
	});

	throws(function () {
		schemas.copyJSON([, 1]);
	});

	var shared = { value: 1 };
	var result = schemas.copyJSON({
		first: shared,
		second: shared
	});

	assert(result.first !== result.second);
	assert(result.first.value === 1 && result.second.value === 1);
}

function testJob() {
	var fields = {
		title: "$:/temp/clerus/jobs/browser/test",
		type: "application/json",
		"clerus-executor": "test",
		text: JSON.stringify({ charter: charter() })
	};

	assert(
		schemas.ephemeralJob(fields, "browser").custody === "user"
	);

	fields.text = "null";

	throws(function () {
		schemas.ephemeralJob(fields, "browser");
	}, "Registry must be a JSON record");
}

function testTransitions(tw) {
	var wiki = new tw.Wiki();
	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var title = "Core2 Transition Test";

	assert(store.read(title).kind === "absent");

	var creation = stores.transition(title, null, {
		title: title,
		text: "first"
	});

	assert(store.apply(creation) === "applied");
	assert(store.apply(creation) === "already-applied");

	var before = store.read(title).fields;

	var update = stores.transition(title, before, {
		title: title,
		text: "second"
	});

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		text: "intervention"
	}));

	throws(function () {
		store.apply(update);
	}, "conflict");

	assert(wiki.getTiddlerText(title) === "intervention");

	var removal = stores.transition(
		title,
		store.read(title).fields,
		null
	);

	assert(store.apply(removal) === "applied");
	assert(store.apply(removal) === "already-applied");
	assert(store.read(title).kind === "absent");
}

function testSnapshotIsolation(tw) {
	var wiki = new tw.Wiki();
	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	wiki.addTiddler(new tw.Tiddler({
		title: "Core2 Snapshot Test",
		text: "original"
	}));

	var view = store.read("Core2 Snapshot Test");
	view.fields.text = "local";

	assert(
		wiki.getTiddlerText("Core2 Snapshot Test") === "original"
	);
}

exports.run = function (tw) {
	var cases = [
		["schemas: registries and safe keys", testRegistries],
		["schemas: strict JSON boundary", testJSONBoundary],
		["schemas: ephemeral job", testJob],
		["store: transitions, replay and conflicts", function () {
			testTransitions(tw);
		}],
		["store: snapshot isolation", function () {
			testSnapshotIsolation(tw);
		}]
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