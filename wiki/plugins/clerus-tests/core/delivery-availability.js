/*\
title: $:/plugins/clerus/tests/core/delivery-availability.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var plannedReactions = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw, settings) {
	settings = settings || {};

	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";

	var titles = {
		root: "$:/clerus/jobs/availability-root",

		target: settings.ephemeral
			? "$:/temp/clerus/jobs/" + platform + "/availability-target"
			: "$:/clerus/jobs/availability-target",

		peer: settings.ephemeral
			? "$:/temp/clerus/jobs/" + platform + "/availability-peer"
			: "$:/clerus/jobs/availability-peer"
	};

	var enabled = settings.enabled !== false;
	var sequence = 0;
	var calls = { root: 0, target: 0, peer: 0 };
	var receivedIds = [];

	function write(name, registry, custody) {
		registry.charter = {
			form: "charter",
			status: {}
		};

		wiki.addTiddler(new tw.Tiddler({
			title: titles[name],
			type: "application/json",
			"clerus-custody": custody || platform,
			"clerus-executor": name,
			text: JSON.stringify(registry)
		}));
	}

	write("root", {
		target: titles.target,
		note: { form: "memo", data: 42 }
	});

	write("target", {
		peer: titles.peer
	}, settings.userCustody ? "user" : platform);

	write("peer", {});

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "availability-test-" +
				String(sequence).padStart(10, "0");
		},

		resolveExecutor: function (name) {
			if (name === "target" && !enabled) {
				return undefined;
			}

			if (name === "root") {
				return function (event, operational) {
					calls.root++;

					var outgoing = operational.outgoing();

					operational.copy("note", outgoing, "input");
					operational.get("target").order(outgoing);
				};
			}

			if (name === "target") {
				return function (event, operational, incoming) {
					calls.target++;
					receivedIds.push(event.id);

					if (settings.transit) {
						var outgoing = incoming.outgoing();

						incoming.move("input", outgoing, "input");
						operational.get("peer").order(outgoing);
					} else {
						incoming.destroy("input");
					}
				};
			}

			if (name === "peer") {
				return function (event, operational, incoming) {
					calls.peer++;
					incoming.destroy("input");
				};
			}
		}
	});

	return {
		wiki: wiki,
		platform: platform,
		titles: titles,
		calls: calls,
		receivedIds: receivedIds,
		runtime: runtime,

		enable: function () {
			enabled = true;
		},

		start: function () {
			return runtime.dispatch(
				titles.root,
				{ type: "test" }
			);
		}
	};
}

function testUnavailableExecutor(tw, ephemeral) {
	var f = fixture(tw, {
		ephemeral: ephemeral,
		enabled: false
	});

	var first = f.start();

	assert(first.status === "completed");
	assert(first.flow.unavailable.length === 1);
	assert(first.flow.remaining === 1);
	assert(f.calls.root === 1);
	assert(f.calls.target === 0);

	var id = first.pending[0].id;
	var body = f.wiki.getTiddler(first.obligation).fields.text;

	for (var index = 0; index < 2; index++) {
		var retried = f.runtime.drainFlows();

		assert(retried.unavailable.length === 1);
		assert(retried.remaining === 1);
		assert(f.calls.target === 0);

		assert(
			f.wiki.getTiddler(first.obligation).fields.text === body
		);
	}

	f.enable();

	var completed = f.runtime.drainFlows();

	assert(completed.errors.length === 0);
	assert(completed.completed.length === 1);
	assert(completed.remaining === 0);
	assert(f.calls.root === 1);
	assert(f.calls.target === 1);
	assert(f.receivedIds[0] === id);
	assert(!f.wiki.getTiddler(first.obligation));

	var repeated = f.runtime.drainFlows();

	assert(repeated.completed.length === 0);
	assert(f.calls.target === 1);
}

function testPersistentUnavailable(tw) {
	testUnavailableExecutor(tw, false);
}

function testEphemeralUnavailable(tw) {
	testUnavailableExecutor(tw, true);
}

function testChangedExecutorPreservesObligation(tw) {
	var f = fixture(tw, {
		enabled: false
	});

	var first = f.start();

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.titles.target),
		{ "clerus-executor": "replacement" }
	));

	f.enable();

	var blocked = f.runtime.drainFlows();

	assert(blocked.unavailable.length === 1);
	assert(blocked.remaining === 1);
	assert(f.calls.target === 0);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.titles.target),
		{ "clerus-executor": "target" }
	));

	var completed = f.runtime.drainFlows();

	assert(completed.completed.length === 1);
	assert(f.calls.target === 1);
	assert(f.receivedIds[0] === first.pending[0].id);
}

function testPersistentUserCustodyPermitsTransit(tw) {
	var f = fixture(tw, {
		userCustody: true,
		transit: true
	});

	var before = f.wiki.getTiddler(f.titles.target).fields.text;

	var result = f.start();

	assert(result.status === "completed");
	assert(result.flow.errors.length === 0);
	assert(result.flow.remaining === 0);
	assert(f.calls.target === 1);
	assert(f.calls.peer === 1);

	assert(
		f.wiki.getTiddler(f.titles.target).fields.text === before
	);

	assert(
		f.wiki.getTiddler(f.titles.target)
			.fields["clerus-custody"] === "user"
	);

	assert(!f.wiki.getTiddler(result.obligation));
}

function testUnfinishedPlanBlocksButDoesNotConsumeMessage(tw) {
	var f = fixture(tw);

	var proposal = plannedReactions.execute({
		store: f.runtime.store,
		title: f.titles.target,
		platform: f.platform,
		event: { type: "prepare" },

		handler: function (event, operational) {
			operational.get("charter").setStatus({
				phase: "prepared"
			});
		}
	});

	var blocker = f.runtime.obligations.accept(proposal);

	var first = f.start();

	assert(first.status === "completed");
	assert(first.flow.blocked.length === 1);
	assert(first.flow.remaining === 1);
	assert(f.calls.target === 0);

	var id = first.pending[0].id;

	var recovery = f.runtime.recover();

	assert(recovery.entries.some(function (entry) {
		return entry.title === blocker &&
			entry.status === "completed";
	}));

	assert(f.calls.target === 0);
	assert(!f.wiki.getTiddler(blocker));

	var completed = f.runtime.drainFlows();

	assert(completed.errors.length === 0);
	assert(completed.completed.length === 1);
	assert(completed.remaining === 0);
	assert(f.calls.target === 1);
	assert(f.receivedIds[0] === id);
	assert(!f.wiki.getTiddler(first.obligation));
}

exports.run = function (tw) {
	var cases = [
		["availability: persistent executor may remain unavailable", testPersistentUnavailable],
		["availability: ephemeral executor may remain unavailable", testEphemeralUnavailable],
		["availability: executor replacement preserves pending work", testChangedExecutorPreservesObligation],
		["availability: user custody permits persistent transit", testPersistentUserCustodyPermitsTransit],
		["availability: unfinished plan blocks without consuming delivery", testUnfinishedPlanBlocksButDoesNotConsumeMessage]
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