/*\
title: $:/plugins/clerus/tests/core/observation-preparation.js
type: application/javascript
module-type: library
\*/

"use strict";

var observation = require("$:/plugins/clerus/core/observation.js");
var Store = require("$:/plugins/clerus/core/store.js").Store;

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function throws(fn) {
	var caught = false;

	try {
		fn();
	} catch (error) {
		caught = true;
	}

	assert(caught, "Expected an exception");
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/observation-preparation";
	var target = "Observation Preparation Target";
	var observer = new observation.Observer();

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "observation-preparation",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			document: target
		})
	}));

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	return {
		wiki: wiki,
		platform: platform,
		title: title,
		target: target,
		observer: observer,

		options: {
			store: store,
			platform: platform,
			titles: [title]
		},

		write: function (value) {
			wiki.addTiddler(new tw.Tiddler({
				title: target,
				text: value
			}));
		}
	};
}

function testPreparationDoesNotAdvanceHistory(tw) {
	var f = fixture(tw);

	assert(f.observer.collect(f.options).length === 0);

	f.write("changed");

	var first = f.observer.prepare(f.options);
	var second = f.observer.prepare(f.options);

	assert(first.events.length === 1);
	assert(second.events.length === 1);
	assert(Object.isFrozen(first));
	assert(Object.isFrozen(first.events));

	f.observer.commit(first);

	assert(f.observer.collect(f.options).length === 0);

	throws(function () {
		f.observer.commit(second);
	});

	throws(function () {
		f.observer.commit(first);
	});
}

function testClearInvalidatesPreparedBatch(tw) {
	var f = fixture(tw);

	f.observer.collect(f.options);
	f.write("changed");

	var batch = f.observer.prepare(f.options);

	assert(batch.events.length === 1);

	f.observer.clear();

	throws(function () {
		f.observer.commit(batch);
	});

	// The next collection establishes a new baseline.
	assert(f.observer.collect(f.options).length === 0);
}

function testForeignObserverCannotCommit(tw) {
	var f = fixture(tw);
	var other = new observation.Observer();

	var batch = f.observer.prepare(f.options);

	throws(function () {
		other.commit(batch);
	});

	// Rejection by another observer did not consume the batch.
	f.observer.commit(batch);

	assert(f.observer.collect(f.options).length === 0);
}

function testPersistentSubscriptionRefresh(tw) {
	var f = fixture(tw);

	f.observer.collect(f.options);
	f.write("changed");

	var batch = f.observer.prepare(f.options);

	assert(batch.events.length === 1);
	assert(batch.events[0].title === f.title);

	var tiddler = f.wiki.getTiddler(f.title);
	var registry = JSON.parse(tiddler.fields.text);

	registry.renamed = registry.document;
	delete registry.document;

	f.wiki.addTiddler(new tw.Tiddler(tiddler, {
		text: JSON.stringify(registry)
	}));

	var current = observation.refresh(
		batch.events[0],
		f.options
	);

	assert(current !== null);
	assert(current.keys.join(",") === "renamed");

	f.observer.commit(batch);

	// Renaming the key does not start a different subscription.
	f.write("changed again");

	assert(f.observer.collect(f.options).length === 1);
}

exports.run = function (tw) {
	var cases = [
		["observation preparation: history advances only on commit", testPreparationDoesNotAdvanceHistory],
		["observation preparation: clear invalidates a prepared batch", testClearInvalidatesPreparedBatch],
		["observation preparation: another observer cannot commit a batch", testForeignObserverCannotCommit],
		["observation preparation: persistent subscriptions can be refreshed", testPersistentSubscriptionRefresh]
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