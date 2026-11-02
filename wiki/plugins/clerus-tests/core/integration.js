/*\
title: $:/plugins/clerus/tests/core/integration.js
type: application/javascript
module-type: library
\*/

"use strict";

var observation = require(
	"$:/plugins/clerus/core/observation.js"
);

var reactions = require(
	"$:/plugins/clerus/core/reaction.js"
);

var Store = require(
	"$:/plugins/clerus/core/store.js"
).Store;

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw, references) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title =
		"$:/temp/clerus/jobs/" + platform + "/integration";

	var registry = {
		charter: {
			form: "charter",
			status: { phase: "initial" }
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
		"clerus-custody": platform,
		"clerus-executor": "integration",
		text: JSON.stringify(registry)
	}));

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var observer = new observation.Observer();

	function collect() {
		return observer.collect({
			store: store,
			platform: platform,
			titles: [title]
		});
	}

	function deliver(event, handler) {
		var current = observation.refresh(event, {
			store: store,
			platform: platform
		});

		if (!current) {
			return false;
		}

		reactions.execute({
			store: store,
			title: current.title,
			platform: platform,
			event: current,
			handler: handler
		});

		return true;
	}

	return {
		wiki: wiki,
		store: store,
		title: title,
		platform: platform,
		collect: collect,
		deliver: deliver,

		write: function (target, text) {
			wiki.addTiddler(new tw.Tiddler({
				title: target,
				text: text
			}));
		},

		react: function (handler) {
			return reactions.execute({
				store: store,
				title: title,
				platform: platform,
				event: { type: "test" },
				handler: handler
			});
		},

		registry: function () {
			return JSON.parse(
				wiki.getTiddler(title).fields.text
			);
		}
	};
}

function testObservedReaction(tw) {
	var target = "Core2 Integration Target";
	var f = fixture(tw, {
		first: target,
		second: target
	});

	var count = 0;

	f.collect();
	f.write(target, "changed");

	var events = f.collect();

	assert(events.length === 1);

	assert(f.deliver(events[0], function (event, operational) {
		count++;

		assert(event.keys.join(",") === "first,second");

		var first = operational.get(event.keys[0]);
		var second = operational.get(event.keys[1]);

		assert(first === second);
		assert(first.text() === "changed");

		operational.get("charter").setStatus({
			observed: first.text()
		});
	}));

	assert(count === 1);
	assert(
		f.registry().charter.status.observed === "changed"
	);

	// Changing the observer's own status does not change the target.
	assert(f.collect().length === 0);
}

function testRefreshesKeys(tw) {
	var target = "Core2 Integration Renamed Key";
	var f = fixture(tw, { old: target });

	f.collect();
	f.write(target, "changed");

	var event = f.collect()[0];

	f.react(function (event, operational) {
		operational.move("old", operational, "new");
	});

	var called = false;

	assert(f.deliver(event, function (event, operational) {
		called = true;

		assert(event.keys.join(",") === "new");
		assert(operational.get("new").text() === "changed");
	}));

	assert(called);

	// A key rename did not establish a new subscription.
	f.write(target, "changed again");
	assert(f.collect().length === 1);
}

function testEarlierReactionInvalidatesLaterEvent(tw) {
	var first = "Core2 Integration A";
	var second = "Core2 Integration B";

	var f = fixture(tw, {
		first: first,
		second: second
	});

	f.collect();

	f.write(first, "first changed");
	f.write(second, "second changed");

	var events = f.collect();
	var seen = [];

	assert(events.length === 2);

	events.forEach(function (event) {
		f.deliver(event, function (event, operational) {
			seen.push(event.target);

			if (event.target === first) {
				operational.destroy("second");
			}
		});
	});

	assert(seen.length === 1);
	assert(seen[0] === first);
	assert(!Object.prototype.hasOwnProperty.call(
		f.registry(),
		"second"
	));
}

function testReadsCurrentTarget(tw) {
	var target = "Core2 Integration Latest State";
	var f = fixture(tw, { document: target });

	f.collect();
	f.write(target, "collected state");

	var event = f.collect()[0];

	f.write(target, "delivery state");

	var observed;

	assert(f.deliver(event, function (event, operational) {
		observed = operational.get(event.keys[0]).text();
	}));

	assert(observed === "delivery state");

	/*
	The collector has not yet observed this newer state.
	A subsequent collection may therefore produce another event.
	*/
	assert(f.collect().length === 1);
}

function testMissingRecipient(tw) {
	var target = "Core2 Integration Missing Recipient";
	var f = fixture(tw, { document: target });

	f.collect();
	f.write(target, "changed");

	var event = f.collect()[0];

	f.wiki.deleteTiddler(f.title);

	assert(
		f.deliver(event, function () {
			throw new Error("Missing recipient was invoked");
		}) === false
	);
}

function testUserCustodyStillAllowsObservation(tw) {
	var target = "Core2 Integration User Custody";
	var f = fixture(tw, { document: target });

	f.collect();

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.title),
		{ "clerus-custody": "user" }
	));

	f.write(target, "changed");

	var events = f.collect();
	var observed;

	assert(events.length === 1);

	assert(f.deliver(events[0], function (event, operational) {
		observed = operational.get(event.keys[0]).text();
	}));

	assert(observed === "changed");
	assert(
		f.wiki.getTiddler(f.title)
			.fields["clerus-custody"] === "user"
	);
}

exports.run = function (tw) {
	var cases = [
		["integration: observed change drives a reaction", testObservedReaction],
		["integration: delivery refreshes reference keys", testRefreshesKeys],
		["integration: earlier reaction invalidates later event", testEarlierReactionInvalidatesLaterEvent],
		["integration: reaction reads current target state", testReadsCurrentTarget],
		["integration: missing recipient is not invoked", testMissingRecipient],
		["integration: custody does not suppress observation", testUserCustodyStillAllowsObservation]
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