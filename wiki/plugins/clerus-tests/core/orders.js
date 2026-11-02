/*\
title: $:/plugins/clerus/tests/core/orders.js
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

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/";
	var owner = prefix + "order-owner";
	var target = prefix + "order-target";

	function write(title, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": title === owner ? "owner" : "target",
			text: JSON.stringify(registry)
		}));
	}

	write(owner, {
		charter: { form: "charter", status: {} },
		subordinate: target,
		note: { form: "memo", data: { value: 42 } }
	});

	write(target, {
		charter: { form: "charter", status: { phase: "idle" } }
	});

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var queue = [];

	return {
		wiki: wiki,
		owner: owner,
		target: target,
		queue: queue,

		execute: function (handler, accept) {
			return reactions.execute({
				store: store,
				title: owner,
				platform: platform,
				event: { type: "test" },

				readJobs: function () {
					return [owner, target].map(function (title) {
						var tiddler = wiki.getTiddler(title);

						return {
							title: title,
							custody: tiddler.fields["clerus-custody"],
							registry: JSON.parse(tiddler.fields.text)
						};
					});
				},

				acceptMessage: accept || function (message) {
					queue.push(message);
				},

				handler: handler
			});
		}
	};
}

function testSendingConsumesRegistry(tw) {
	var f = fixture(tw);
	var targetBefore = f.wiki.getTiddler(f.target).fields.text;

	var result = f.execute(function (event, operational) {
		var outgoing = operational.outgoing();

		operational.copy("note", outgoing, "instruction");

		var sentNote = outgoing.get("instruction");

		operational.get("subordinate").order(outgoing);

		assert(f.queue.length === 1);

		throws(function () {
			outgoing.keys();
		}, "no longer available");

		throws(function () {
			sentNote.data();
		}, "no longer available");

		throws(function () {
			operational.get("subordinate").order(outgoing);
		}, "no longer available");

		assert(f.queue.length === 1);
	});

	assert(result.outgoing.length === 0);
	assert(result.messages.length === 1);
	assert(f.queue[0].registry.instruction.data.value === 42);

	result.messages[0].registry.instruction.data.value = 99;

	assert(f.queue[0].registry.instruction.data.value === 42);
	assert(f.wiki.getTiddler(f.target).fields.text === targetBefore);
}

function testLaterFailureDoesNotUndoSending(tw) {
	var f = fixture(tw);

	throws(function () {
		f.execute(function (event, operational) {
			var outgoing = operational.outgoing();

			operational.copy("note", outgoing, "instruction");
			operational.get("subordinate").order(outgoing);

			throw new Error("Failure after sending");
		});
	}, "Failure after sending");

	assert(f.queue.length === 1);
	assert(f.queue[0].registry.instruction.data.value === 42);
}

function testDeniedOrderPreservesRegistry(tw) {
	var f = fixture(tw);

	f.execute(function (event, operational) {
		var outgoing = operational.outgoing();

		// The recipient's own title cannot be carried by the order.
		operational.copy("subordinate", outgoing, "forbidden");

		throws(function () {
			operational.get("subordinate").order(outgoing);
		}, "recipient or its superior");

		assert(outgoing.keys().join(",") === "forbidden");
		assert(f.queue.length === 0);

		outgoing.destroy("forbidden");

		operational.copy("note", outgoing, "instruction");
		operational.get("subordinate").order(outgoing);

		assert(f.queue.length === 1);
	});
}

function testAcceptanceFailureClosesScope(tw) {
	var f = fixture(tw);
	var saved;

	throws(function () {
		f.execute(function (event, operational) {
			saved = operational.get("note");

			var outgoing = operational.outgoing();

			operational.copy("note", outgoing, "instruction");
			operational.get("subordinate").order(outgoing);
		}, function () {
			throw new Error("Injected queue failure");
		});
	}, "Injected queue failure");

	throws(function () {
		saved.data();
	}, "closed");
}

exports.run = function (tw) {
	var cases = [
		["orders: sending consumes the outgoing registry", testSendingConsumesRegistry],
		["orders: later ephemeral failure preserves sending", testLaterFailureDoesNotUndoSending],
		["orders: policy rejection preserves prepared documents", testDeniedOrderPreservesRegistry],
		["orders: acceptance failure closes access", testAcceptanceFailureClosesScope]
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