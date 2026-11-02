/*\
title: $:/plugins/clerus/tests/core/job-titles.js
type: application/javascript
module-type: library
\*/

"use strict";

var scopes = require("$:/plugins/clerus/core/scope.js");
var jobViews = require("$:/plugins/clerus/core/job-view.js");
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

function fixture(tw) {
	var wiki = new tw.Wiki();
	var title = "$:/clerus/jobs/job-title-target";

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	return {
		wiki: wiki,
		title: title,

		writeStatus: function (status) {
			wiki.addTiddler(new tw.Tiddler({
				title: title,
				type: "application/json",
				"clerus-custody": "user",
				"clerus-executor": "target",
				text: JSON.stringify({
					charter: {
						form: "charter",
						status: status
					}
				})
			}));
		},

		open: function () {
			return scopes.open({
				operational: {
					charter: {
						form: "charter",
						status: {}
					}
				},
				incoming: {
					first: title,
					second: title
				},
				readJob: function (target) {
					return jobViews.read(store, target);
				}
			});
		}
	};
}

function testStatusLifecycle(tw) {
	var f = fixture(tw);
	var scope = f.open();

	try {
		var title = scope.incoming.get("first");

		assert(!title.inspect().exists);

		throws(function () {
			title.status();
		}, "does not exist");

		f.writeStatus({ phase: "initial" });

		assert(title.status().phase === "initial");

		var status = title.status();
		status.phase = "local mutation";

		assert(title.status().phase === "initial");

		f.writeStatus({ phase: "updated" });

		assert(title.status().phase === "updated");

		f.wiki.deleteTiddler(f.title);

		assert(!title.inspect().exists);
	} finally {
		scope.close();
	}
}

function testRepeatedRepresentations(tw) {
	var f = fixture(tw);
	var scope = f.open();

	try {
		f.writeStatus({ value: 1 });

		var title = scope.incoming.get("first");

		assert(title === scope.incoming.get("second"));

		scope.incoming.destroy("first");

		assert(title.status().value === 1);

		scope.incoming.destroy("second");

		throws(function () {
			title.inspect();
		}, "no longer available");

		scope.assertResolved();
	} finally {
		scope.close();
	}
}

function testMalformedTarget(tw) {
	var f = fixture(tw);
	var scope = f.open();

	try {
		f.wiki.addTiddler(new tw.Tiddler({
			title: f.title,
			type: "application/json",
			text: "null"
		}));

		var title = scope.incoming.get("first");
		var view = title.inspect();

		assert(view.exists);
		assert(!view.readable);

		throws(function () {
			title.status();
		}, "JSON record");
	} finally {
		scope.close();
	}
}

function testTransferIsNotAccidentallyEnabled(tw) {
	var f = fixture(tw);
	var scope = f.open();

	try {
		var outgoing = scope.incoming.outgoing();
		var title = scope.incoming.get("first");

		scope.incoming.copy("first", outgoing, "copy");

		assert(outgoing.get("copy") === title);
		assert(scope.incoming.keys().length === 2);

		scope.incoming.move("second", outgoing, "moved");

		assert(outgoing.get("moved") === title);
		assert(scope.incoming.keys().length === 1);

		throws(function () {
			scope.incoming.move(
				"first",
				scope.operational,
				"subordinate"
			);
		}, "authorization is unavailable");

		assert(scope.incoming.keys().length === 1);
		assert(outgoing.keys().length === 2);
	} finally {
		scope.close();
	}
}

function testClosedForm(tw) {
	var f = fixture(tw);
	var scope = f.open();
	var title = scope.incoming.get("first");

	scope.close();

	throws(function () {
		title.status();
	}, "closed");
}

exports.run = function (tw) {
	var cases = [
		["job titles: status lifecycle and isolated reads", testStatusLifecycle],
		["job titles: repeated representations share access", testRepeatedRepresentations],
		["job titles: malformed target is unreadable", testMalformedTarget],
		["job titles: transactional transfer requires no organizational edge", testTransferIsNotAccidentallyEnabled],
		["job titles: closed form provides no access", testClosedForm]
	];

	var results = cases.map(function (item) {
		try {
			item[1](tw);

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