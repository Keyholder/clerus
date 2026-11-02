/*\
title: $:/plugins/clerus/core/tests/collection-obligations.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var planned = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function environment(tw, handlers) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var sequence = 0;

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "collection-obligation-" +
				String(sequence).padStart(10, "0");
		},

		resolveExecutor: function (name) {
			return handlers[name];
		}
	});

	function add(name, extra) {
		var title = "$:/clerus/jobs/collection-obligation-" + name;

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": name,

			text: JSON.stringify(Object.assign({
				charter: { form: "charter", status: {} }
			}, extra || {}))
		}));

		return title;
	}

	return {
		wiki: wiki,
		platform: platform,
		runtime: runtime,
		add: add,

		authorize: function (title) {
			wiki.addTiddler(new tw.Tiddler(
				wiki.getTiddler(title),
				{ "clerus-custody": platform }
			));
		}
	};
}

function testActivePlanProtectsOnlyItsOwner(tw) {
	var f = environment(tw, {});
	var owner = f.add("active-owner");
	var spare = f.add("active-spare");

	var proposal = planned.execute({
		store: f.runtime.store,
		title: owner,
		platform: f.platform,
		event: { type: "test" },

		handler: function (event, operational) {
			operational.get("charter").setStatus({
				phase: "proposed"
			});
		}
	});

	var journal = f.runtime.obligations.accept(proposal);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(journal),
		{ "clerus-custody": "user" }
	));

	var first = f.runtime.collect();

	assert(first.blocked.length === 0);
	assert(first.removed.includes(spare));
	assert(!first.removed.includes(owner));
	assert(f.wiki.getTiddler(owner));

	f.authorize(journal);
	f.runtime.recover();

	var second = f.runtime.collect();

	assert(second.removed.includes(owner));
	assert(!f.wiki.getTiddler(journal));
}

function testPendingMessageDoesNotRetainFormerSender(tw) {
	var handlers = {};

	handlers.source = function (event, operational) {
		var outgoing = operational.outgoing();

		operational.copy("note", outgoing, "input");
		operational.get("target").order(outgoing);

		operational.destroy("target");
	};

	var f = environment(tw, handlers);
	var target = f.add("target");

	var source = f.add("source", {
		target: target,
		note: { form: "memo", data: 42 }
	});

	var spare = f.add("pending-spare");

	var sent = f.runtime.dispatch(source, { type: "test" });

	assert(sent.flow.unavailable.length === 1);
	assert(sent.flow.remaining === 1);

	var collected = f.runtime.collect();

	assert(collected.blocked.length === 0);
	assert(collected.removed.includes(source));
	assert(collected.removed.includes(spare));
	assert(!collected.removed.includes(target));
	assert(f.wiki.getTiddler(target));

	handlers.target = function (event, operational, incoming) {
		incoming.move("input", operational, "received");
	};

	var delivered = f.runtime.drainFlows();

	assert(delivered.errors.length === 0);
	assert(delivered.completed.length === 1);
	assert(!f.wiki.getTiddler(sent.obligation));

	var registry = JSON.parse(
		f.wiki.getTiddler(target).fields.text
	);

	assert(registry.received.data === 42);

	var final = f.runtime.collect();

	assert(final.removed.includes(target));
}

function testPersistentTickRetainsAddressedJob(tw) {
	var ticks = 0;

	var f = environment(tw, {
		ticker: function (event, operational) {
			if (event.type === "tick") {
				ticks++;
				return;
			}

			operational.get("charter").defer();
		}
	});

	var owner = f.add("ticker");
	var spare = f.add("tick-spare");

	f.runtime.dispatch(owner, { type: "schedule" });

	var first = f.runtime.collect();

	assert(first.blocked.length === 0);
	assert(first.removed.includes(spare));
	assert(!first.removed.includes(owner));

	var activated = f.runtime.runDeferred();

	assert(activated.persistent[0].result.status === "completed");
	assert(ticks === 1);

	var second = f.runtime.collect();

	assert(second.removed.includes(owner));
}

function testAcceptedBirthProtectsUnreferencedChild(tw) {
	var initializations = 0;

	var f = environment(tw, {
		founder: function (event, operational) {
			var child = operational.get("charter").createTitle(
				"worker",
				operational,
				"child"
			);

			var outgoing = operational.outgoing();

			operational.move("contract", outgoing, "contract");
			child.order(outgoing);

			operational.destroy("child");
		},

		initializer: function (event, operational, incoming) {
			initializations++;

			incoming.get("contract").accept(
				"charter",
				{ phase: "initialized" }
			);
		}
	});

	var founder = f.add("founder", {
		contract: {
			form: "contract",
			executor: "initializer",
			temp: false
		}
	});

	var spare = f.add("birth-spare");
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (
			!injected &&
			effect.before === null &&
			effect.after &&
			effect.after["clerus-executor"] === "initializer"
		) {
			injected = true;
			throw new Error("Interrupted after child birth");
		}

		return result;
	};

	var founded;

	try {
		founded = f.runtime.dispatch(
			founder,
			{ type: "found" }
		);
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(founded.flow.errors.length === 1);
	assert(initializations === 1);

	var child = founded.pending[0].recipient.title;

	assert(f.wiki.getTiddler(child));

	var first = f.runtime.collect();

	assert(first.blocked.length === 0);
	assert(first.removed.includes(founder));
	assert(first.removed.includes(spare));
	assert(!first.removed.includes(child));

	f.authorize(founded.obligation);
	f.runtime.recover();

	assert(initializations === 1);
	assert(!f.wiki.getTiddler(founded.obligation));

	var second = f.runtime.collect();

	assert(second.removed.includes(child));
}

exports.run = function (tw) {
	var cases = [
		["collection obligations: active plan protects only its owner", testActivePlanProtectsOnlyItsOwner],
		["collection obligations: pending message does not retain former sender", testPendingMessageDoesNotRetainFormerSender],
		["collection obligations: persistent tick retains its address", testPersistentTickRetainsAddressedJob],
		["collection obligations: accepted birth protects an unreferenced child", testAcceptedBirthProtectsUnreferencedChild]
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