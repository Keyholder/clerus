/*\
title: $:/plugins/clerus/core2/tests/ephemeral-acknowledgement.js
type: application/javascript
module-type: library
\*/

"use strict";

var flows = require(
	"$:/plugins/clerus/core2/flow-obligations.js"
);
var reactions = require(
	"$:/plugins/clerus/core2/reaction.js"
);
var Store = require("$:/plugins/clerus/core2/store.js").Store;

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
	var source = "$:/clerus/jobs/ephemeral-ack-source";
	var target =
		"$:/temp/clerus/jobs/" + platform + "/ephemeral-ack-target";

	function write(title, executor, registry) {
		registry.charter = {
			form: "charter",
			status: {}
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
		target: target
	});

	write(target, "target", {
		counter: {
			form: "memo",
			data: 0
		}
	});

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	function service() {
		return flows.create({
			store: store,
			platform: platform,
			newId: function () {
				return "ephemeral-ack-flow-identity";
			}
		});
	}

	var manager = service();

	var message = {
		version: 1,
		kind: "official-message",
		id: "ephemeral-ack-message-0001",
		platform: platform,
		type: "order",
		source: {
			title: source,
			executor: "source"
		},
		recipient: {
			title: target,
			executor: "target"
		},
		registry: {
			input: { form: "memo", data: 42 }
		}
	};

	var journal = manager.register({
		version: 1,
		owner: {
			title: source,
			executor: "source",
			state: store.read(source).fields
		},
		plan: {
			version: 1,
			effects: [],
			messages: [message]
		}
	});

	manager.resume(journal);

	var calls = [];

	return {
		wiki: wiki,
		store: store,
		target: target,
		journal: journal,
		manager: manager,
		service: service,
		message: message,
		calls: calls,

		deliver: function (currentManager) {
			var pending = currentManager.pending(journal)[0];

			reactions.execute({
				store: store,
				title: target,
				platform: platform,

				event: {
					type: pending.type,
					id: pending.id
				},

				incoming: pending.registry,

				handler: function (event, operational, incoming) {
					calls.push(event.id);

					var counter = operational.get("counter");

					counter.setData(counter.data() + 1);
					incoming.destroy("input");
				}
			});
		},

		counter: function () {
			return JSON.parse(
				wiki.getTiddler(target).fields.text
			).counter.data;
		}
	};
}

function testCompletionIsExplicit(tw) {
	var f = fixture(tw);

	f.deliver(f.manager);

	assert(f.counter() === 1);
	assert(f.manager.pending(f.journal).length === 1);

	var result = f.manager.completeEphemeral(
		f.journal,
		f.message.id,
		f.message.recipient
	);

	assert(result.status === "completed");
	assert(result.pending.length === 0);
	assert(!f.wiki.getTiddler(f.journal));
}

function testInterruptionBeforeAcknowledgementMayRepeat(tw) {
	var f = fixture(tw);

	f.deliver(f.manager);

	assert(f.counter() === 1);

	/*
		Simulate loss of the process after the reaction but before
		any completion was written.
	*/
	var restarted = f.service();

	assert(restarted.resume(f.journal).length === 1);

	f.deliver(restarted);

	assert(f.counter() === 2);
	assert(f.calls.length === 2);
	assert(f.calls[0] === f.calls[1]);

	restarted.completeEphemeral(
		f.journal,
		f.message.id,
		f.message.recipient
	);

	assert(!f.wiki.getTiddler(f.journal));
}

function testRecordedAcknowledgementPreventsRedispatch(tw) {
	var f = fixture(tw);

	f.deliver(f.manager);

	var originalApply = f.store.apply;
	var injected = false;

	f.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (
			effect.title === f.journal &&
			effect.after &&
			!injected
		) {
			var record = JSON.parse(effect.after.text);

			if (
				record.active === null &&
				record.pending.length === 0
			) {
				injected = true;
				throw new Error("Interrupted after acknowledgement write");
			}
		}

		return result;
	};

	try {
		throws(function () {
			f.manager.completeEphemeral(
				f.journal,
				f.message.id,
				f.message.recipient
			);
		}, "Interrupted after acknowledgement write");
	} finally {
		f.store.apply = originalApply;
	}

	assert(injected);
	assert(f.counter() === 1);

	var restarted = f.service();
	var pending = restarted.resume(f.journal);

	assert(pending.length === 0);
	assert(f.calls.length === 1);
	assert(!f.wiki.getTiddler(f.journal));
}

function testWrongRecipientCannotAcknowledge(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.journal).fields.text;

	throws(function () {
		f.manager.completeEphemeral(
			f.journal,
			f.message.id,
			{
				title: f.target,
				executor: "replacement"
			}
		);
	}, "another recipient");

	assert(f.wiki.getTiddler(f.journal).fields.text === before);
	assert(f.manager.pending(f.journal).length === 1);
}

exports.run = function (tw) {
	var cases = [
		["ephemeral acknowledgement: completion is explicit", testCompletionIsExplicit],
		["ephemeral acknowledgement: interruption may repeat reaction with stable identity", testInterruptionBeforeAcknowledgementMayRepeat],
		["ephemeral acknowledgement: recorded completion prevents redispatch", testRecordedAcknowledgementPreventsRedispatch],
		["ephemeral acknowledgement: recipient identity is checked", testWrongRecipientCannotAcknowledge]
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