/*\
title: $:/plugins/clerus/core/tests/persistent-flow-reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

var persistent = require(
	"$:/plugins/clerus/core/persistent-reaction.js"
);
var flows = require(
	"$:/plugins/clerus/core/flow-obligations.js"
);
var Store = require("$:/plugins/clerus/core/store.js").Store;

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = "$:/clerus/jobs/persistent-flow-source";
	var target = "$:/clerus/jobs/persistent-flow-target";
	var sequence = 0;

	function write(title, executor, registry) {
		registry.charter = {
			form: "charter",
			status: { phase: "initial" }
		};

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(registry)
		}));
	}

	write(source, "source", {
		target: target,
		evidence: {
			form: "memo",
			data: { value: 42 }
		}
	});

	write(target, "target", {});

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	function newId() {
		sequence++;

		return "persistent-flow-" +
			String(sequence).padStart(12, "0");
	}

	function execute(title, handler, flow) {
		return persistent.execute({
			store: store,
			title: title,
			platform: platform,
			event: { type: "test" },
			handler: handler,
			newId: newId,
			flow: flow
		});
	}

	return {
		wiki: wiki,
		store: store,
		source: source,
		target: target,
		platform: platform,

		root: function () {
			return execute(source, function (event, operational) {
				var outgoing = operational.outgoing();

				operational.copy("evidence", outgoing, "input");
				operational.get("target").order(outgoing);

				operational.get("charter").setStatus({
					phase: "sent"
				});
			});
		},

		deliver: function (root, handler) {
			return execute(target, handler, {
				title: root.obligation,
				messageId: root.pending[0].id
			});
		},

		manager: function () {
			return flows.create({
				store: store,
				platform: platform,
				newId: newId
			});
		},

		registry: function (title) {
			return JSON.parse(wiki.getTiddler(title).fields.text);
		}
	};
}

function testEndToEndAcceptance(tw) {
	var f = fixture(tw);
	var root = f.root();

	assert(root.status === "completed");
	assert(root.pending.length === 1);
	assert(f.registry(f.source).charter.status.phase === "sent");
	assert(!f.registry(f.target).received);

	var calls = 0;

	var delivered = f.deliver(root, function (
		event,
		operational,
		incoming
	) {
		calls++;

		assert(event.type === "order");
		assert(event.id === root.pending[0].id);
		assert(!("source" in event));

		assert(!f.registry(f.target).received);

		incoming.move("input", operational, "received");
	});

	assert(delivered.status === "completed");
	assert(delivered.pending.length === 0);
	assert(calls === 1);
	assert(f.registry(f.target).received.data.value === 42);
	assert(!f.wiki.getTiddler(root.obligation));
}

function testReactionFailureCompletesOnlyItsBranch(tw) {
	var f = fixture(tw);
	var root = f.root();
	var before = f.wiki.getTiddler(f.target).fields.text;

	var failed = f.deliver(root, function (
		event,
		operational,
		incoming
	) {
		incoming.move("input", operational, "received");
		throw new Error("Recipient rejected its proposal");
	});

	assert(failed.status === "failed");
	assert(failed.phase === "reaction");
	assert(failed.pending.length === 0);
	assert(f.wiki.getTiddler(f.target).fields.text === before);

	var journal = f.wiki.getTiddler(root.obligation);
	var record = JSON.parse(journal.fields.text);

	assert(journal.fields["clerus-custody"] === "user");
	assert(record.pending.length === 0);
	assert(record.active === null);
	assert(record.errors.length === 1);
	assert(
		record.errors[0].error.message ===
			"Recipient rejected its proposal"
	);
}

function testRecoveryDoesNotRepeatRecipient(tw) {
	var f = fixture(tw);
	var root = f.root();
	var originalApply = f.store.apply;
	var calls = 0;
	var injected = false;

	f.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.target && !injected) {
			injected = true;
			throw new Error("Interrupted recipient materialization");
		}

		return result;
	};

	var failed;

	try {
		failed = f.deliver(root, function (
			event,
			operational,
			incoming
		) {
			calls++;
			incoming.move("input", operational, "received");
		});
	} finally {
		f.store.apply = originalApply;
	}

	assert(failed.status === "failed");
	assert(failed.phase === "materialization");
	assert(calls === 1);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(root.obligation),
		{ "clerus-custody": f.platform }
	));

	var pending = f.manager().resume(root.obligation);

	assert(pending.length === 0);
	assert(calls === 1);
	assert(f.registry(f.target).received.data.value === 42);
	assert(!f.wiki.getTiddler(root.obligation));
}

function testRecipientReplacementPreservesMessage(tw) {
	var f = fixture(tw);
	var root = f.root();

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.target),
		{ "clerus-executor": "replacement" }
	));

	var called = false;

	var result = f.deliver(root, function () {
		called = true;
	});

	assert(result.status === "unavailable");
	assert(result.reason === "flow-recipient-changed");
	assert(!called);
	assert(f.manager().pending(root.obligation).length === 1);
}

exports.run = function (tw) {
	var cases = [
		["persistent flow reaction: sending and recipient acceptance are connected", testEndToEndAcceptance],
		["persistent flow reaction: failed proposal becomes branch evidence", testReactionFailureCompletesOnlyItsBranch],
		["persistent flow reaction: recovery does not repeat recipient", testRecoveryDoesNotRepeatRecipient],
		["persistent flow reaction: executor replacement preserves pending work", testRecipientReplacementPreservesMessage]
	];

	var results = cases.map(function (item) {
		try {
			item[1](tw);

			return {
				name: item[0],
				passed: true,
				error: null
			};
		}
		catch (error) {
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