/*\
title: $:/plugins/clerus/core2/tests/observation.js
type: application/javascript
module-type: library
\*/

"use strict";

var Observer = require(
	"$:/plugins/clerus/core2/observation.js"
).Observer;

var Store = require(
	"$:/plugins/clerus/core2/store.js"
).Store;

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
	var platform = tw.browser ? "browser" : "node";
	var title =
		"$:/temp/clerus/jobs/" + platform + "/observer-test";

	var observer = new Observer();
	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	function setRegistry(references) {
		var registry = {
			charter: {
				form: "charter",
				status: {}
			}
		};

		Object.keys(references).forEach(function (key) {
			Object.defineProperty(registry, key, {
				value: references[key],
				enumerable: true,
				writable: true,
				configurable: true
			});
		});

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": "user",
			"clerus-executor": "observer-test",
			text: JSON.stringify(registry)
		}));
	}

	return {
		wiki: wiki,
		store: store,
		observer: observer,
		title: title,
		platform: platform,
		setRegistry: setRegistry,

		write: function (target, text) {
			wiki.addTiddler(new tw.Tiddler({
				title: target,
				text: text
			}));
		},

		collect: function () {
			return observer.collect({
				store: store,
				platform: platform,
				titles: [title]
			});
		}
	};
}

function testLifecycle(tw) {
	var f = fixture(tw);
	var target = "Core2 Observed Target";

	f.setRegistry({ document: target });

	assert(f.collect().length === 0);

	f.write(target, "created");
	assert(f.collect().length === 1);
	assert(f.collect().length === 0);

	f.write(target, "updated");
	assert(f.collect().length === 1);

	f.wiki.deleteTiddler(target);
	assert(f.collect().length === 1);

	f.write(target, "restored");
	assert(f.collect().length === 1);
}

function testDuplicates(tw) {
	var f = fixture(tw);
	var target = "Core2 Duplicate Target";

	f.setRegistry({
		first: target,
		second: target
	});

	f.collect();
	f.write(target, "changed");

	var events = f.collect();

	assert(events.length === 1);
	assert(events[0].target === target);
	assert(events[0].title === f.title);
	assert(events[0].keys.join(",") === "first,second");
	assert(Object.isFrozen(events));
	assert(Object.isFrozen(events[0]));
	assert(Object.isFrozen(events[0].keys));
}

function testKeyChangePreservesSubscription(tw) {
	var f = fixture(tw);
	var target = "Core2 Renamed Reference";

	f.setRegistry({ first: target });
	f.collect();

	/*
	The reference changes its key, but does not disappear from
	the states observed by the collector.
	*/
	f.setRegistry({ replacement: target });
	f.write(target, "changed");

	var events = f.collect();

	assert(events.length === 1);
	assert(events[0].keys.join(",") === "replacement");
}

function testLastRemovalResetsSubscription(tw) {
	var f = fixture(tw);
	var target = "Core2 Removed Reference";

	f.setRegistry({
		first: target,
		second: target
	});

	f.collect();

	f.setRegistry({ second: target });
	f.write(target, "first change");

	assert(f.collect().length === 1);

	f.setRegistry({});
	assert(f.collect().length === 0);

	f.write(target, "unobserved change");
	f.setRegistry({ restored: target });

	// A new subscription starts with a baseline, not a change event.
	assert(f.collect().length === 0);

	f.write(target, "next change");
	assert(f.collect().length === 1);
}

function testIntermediateChangesMayCoalesce(tw) {
	var f = fixture(tw);
	var target = "Core2 Coalesced Target";

	f.setRegistry({ document: target });
	f.write(target, "initial");
	f.collect();

	f.write(target, "intermediate");
	f.write(target, "initial");

	assert(f.collect().length === 0);
}

function testFailedPassDoesNotAdvanceHistory(tw) {
	var f = fixture(tw);
	var target = "Core2 Failed Pass Target";

	f.setRegistry({ document: target });
	f.collect();
	f.write(target, "changed");

	var brokenTitle =
		"$:/temp/clerus/jobs/" + f.platform + "/zz-broken";

	f.wiki.addTiddler(new tw.Tiddler({
		title: brokenTitle,
		type: "application/json",
		"clerus-custody": f.platform,
		"clerus-executor": "broken",
		text: "null"
	}));

	throws(function () {
		f.observer.collect({
			store: f.store,
			platform: f.platform,
			titles: [f.title, brokenTitle]
		});
	}, "Registry must be a JSON record");

	// The earlier valid subscription must not have advanced.
	assert(f.collect().length === 1);
	assert(f.collect().length === 0);
}

function testClear(tw) {
	var f = fixture(tw);
	var target = "Core2 Clear Target";

	f.setRegistry({ document: target });
	f.collect();

	f.write(target, "changed");
	f.observer.clear();

	assert(f.collect().length === 0);
}

exports.run = function (tw) {
	var cases = [
		["observation: target lifecycle", testLifecycle],
		["observation: duplicate references produce one event", testDuplicates],
		["observation: key change preserves subscription", testKeyChangePreservesSubscription],
		["observation: last removal resets subscription", testLastRemovalResetsSubscription],
		["observation: intermediate changes may coalesce", testIntermediateChangesMayCoalesce],
		["observation: failed pass preserves history", testFailedPassDoesNotAdvanceHistory],
		["observation: clear resets baselines", testClear]
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