/*\
title: $:/plugins/clerus/tests/core/reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

var reactions = require("$:/plugins/clerus/core/reaction.js");
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

function fixture(tw, custody) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title =
		"$:/temp/clerus/jobs/" + platform + "/reaction-test";

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": custody || platform,
		"clerus-executor": "reaction-test",
		caption: "Preserved field",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			note: {
				form: "memo",
				data: { value: 1 }
			}
		})
	}));

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	return {
		wiki: wiki,
		store: store,
		title: title,
		platform: platform,

		registry: function () {
			return JSON.parse(
				wiki.getTiddler(title).fields.text
			);
		},

		execute: function (handler, incoming) {
			return reactions.execute({
				store: store,
				title: title,
				platform: platform,
				event: { type: "test" },
				handler: handler,
				incoming: incoming
			});
		}
	};
}

function testWrites(tw) {
	var f = fixture(tw);
	var saved;

	var result = f.execute(function (event, operational) {
		assert(event.title === f.title);
		assert(event.platform === f.platform);
		assert(Object.isFrozen(event));

		saved = operational.get("note");
		saved.setData({ value: 2 });

		assert(
			f.registry().note.data.value === 2,
			"Ephemeral write was deferred"
		);

		operational.get("charter").setStatus({
			phase: "running"
		});
	});

	assert(result.outgoing.length === 0);
	assert(f.registry().charter.status.phase === "running");
	assert(
		f.wiki.getTiddler(f.title).fields.caption ===
			"Preserved field"
	);

	throws(function () {
		saved.data();
	}, "closed");
}

function testTransitWithoutCustody(tw) {
	var f = fixture(tw, "user");
	var before = f.wiki.getTiddler(f.title).fields.text;
	var saved;

	var result = f.execute(function (event, operational, incoming) {
		throws(function () {
			operational.get("note").setData({ value: 99 });
		}, "not writable");

		saved = incoming.get("input");
		saved.setData({ value: 2 });

		var outgoing = incoming.outgoing();

		incoming.move("input", outgoing, "result");

		assert(outgoing.get("result") === saved);
	}, {
		input: {
			form: "memo",
			data: { value: 1 }
		}
	});

	assert(result.outgoing.length === 1);
	assert(result.outgoing[0].result.data.value === 2);
	assert(f.wiki.getTiddler(f.title).fields.text === before);

	throws(function () {
		saved.data();
	}, "closed");
}

function testFailurePreservesMaterializedWork(tw) {
	var f = fixture(tw);
	var saved;

	throws(function () {
		f.execute(function (event, operational) {
			saved = operational.get("note");
			saved.setData({ value: 2 });

			throw new Error("Deliberate failure");
		});
	}, "Deliberate failure");

	var registry = f.registry();

	assert(registry.note.data.value === 2);
	assert(registry.charter.status.phase === "initial");
	assert(
		f.wiki.getTiddler(f.title)
			.fields["clerus-custody"] === f.platform
	);

	throws(function () {
		saved.setData({ value: 3 });
	}, "closed");
}

function testUnresolvedInput(tw) {
	var f = fixture(tw);
	var saved;

	throws(function () {
		f.execute(function (event, operational, incoming) {
			saved = incoming.get("input");

			var outgoing = incoming.outgoing();

			incoming.copy("input", outgoing, "copy");
		}, {
			input: { form: "memo", data: 1 }
		});
	}, "unresolved");

	throws(function () {
		saved.data();
	}, "closed");

	// Explicit destruction resolves the incoming entry.
	var result = f.execute(function (event, operational, incoming) {
		incoming.destroy("input");
	}, {
		input: { form: "memo", data: 1 }
	});

	assert(result.outgoing.length === 0);
}

function testAsyncResult(tw) {
	var f = fixture(tw);
	var saved;

	throws(function () {
		f.execute(function (event, operational) {
			saved = operational.get("note");

			return Promise.resolve();
		});
	}, "must be synchronous");

	throws(function () {
		saved.data();
	}, "closed");
}

function testIntervention(tw) {
	var f = fixture(tw);

	f.execute(function (event, operational) {
		f.wiki.addTiddler(new tw.Tiddler(
			f.wiki.getTiddler(f.title),
			{ caption: "External intervention" }
		));

		throws(function () {
			operational.get("note").setData({ value: 2 });
		}, "not writable");

		assert(operational.get("note").data().value === 1);
	});

	assert(f.registry().note.data.value === 1);
	assert(
		f.wiki.getTiddler(f.title).fields.caption ===
			"External intervention"
	);
}

function testCustodyLoss(tw) {
	var f = fixture(tw);

	f.execute(function (event, operational) {
		operational.get("note").setData({ value: 2 });

		f.wiki.addTiddler(new tw.Tiddler(
			f.wiki.getTiddler(f.title),
			{ "clerus-custody": "user" }
		));

		throws(function () {
			operational.get("charter").setStatus({
				phase: "forbidden"
			});
		}, "not writable");
	});

	assert(f.registry().note.data.value === 2);
	assert(f.registry().charter.status.phase === "initial");
	assert(
		f.wiki.getTiddler(f.title)
			.fields["clerus-custody"] === "user"
	);
}

exports.run = function (tw) {
	var cases = [
		["reaction: immediate operational writes", testWrites],
		["reaction: transit without custody", testTransitWithoutCustody],
		["reaction: failure preserves committed work", testFailurePreservesMaterializedWork],
		["reaction: input must be explicitly resolved", testUnresolvedInput],
		["reaction: asynchronous result is rejected", testAsyncResult],
		["reaction: intervention is not overwritten", testIntervention],
		["reaction: custody is checked between operations", testCustodyLoss]
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