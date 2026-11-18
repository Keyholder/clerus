/*\
title: $:/plugins/clerus/tests/core/event-acceptance.js
type: application/javascript
module-type: library
\*/

"use strict";

var continuations = require(
	"$:/plugins/clerus/core/continuations.js"
);
var plannedReactions = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
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

	var titles = {
		root: "$:/clerus/jobs/accept-flow-root",
		first: "$:/clerus/jobs/accept-flow-first",
		second: "$:/clerus/jobs/accept-flow-second"
	};

	Object.keys(titles).forEach(function (name) {
		wiki.addTiddler(new tw.Tiddler({
			title: titles[name],
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": name,
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: {}
				}
			})
		}));
	});

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var sequence = 0;

	function newId() {
		sequence++;

		return "accept-continuation-" +
			String(sequence).padStart(12, "0");
	}

	function service() {
		return continuations.create({
			store: store,
			platform: platform,
			newId: newId
		});
	}

	var manager = service();

	function message(name) {
		return {
			version: 1,
			kind: "official-message",
			id: "accept-flow-message-" + name,
			platform: platform,
			type: "order",
			source: {
				title: titles.root,
				executor: "root"
			},
			recipient: {
				title: titles[name],
				executor: name
			},
			registry: {
				input: {
					form: "memo",
					data: { name: name }
				}
			}
		};
	}

	var title = manager.accept({
		version: 2,
		id: newId(),
		checks: [],
		transitions: [],
		blocks: [],
		emits: ["first", "second"].map(function (name) {
			var outgoing = message(name);

			return {
				id: outgoing.id,
				event: {
					kind: "delivery",
					type: "order",
					recipient: outgoing.recipient,
					registry: outgoing.registry
				}
			};
		})
	});

	manager.resume(title);

	var handlerCalls = 0;

	function proposal(name) {
		return plannedReactions.execute({
			store: store,
			title: titles[name],
			platform: platform,
			event: { type: "order" },
			incoming: message(name).registry,

			handler: function (event, operational, incoming) {
				handlerCalls++;

				incoming.move(
					"input",
					operational,
					"received"
				);
			}
		});
	}

	return {
		wiki: wiki,
		store: store,
		titles: titles,
		journal: title,
		manager: manager,
		service: service,
		proposal: proposal,

		messageId: function (name) {
			return message(name).id;
		},

		calls: function () {
			return handlerCalls;
		},

		registry: function (name) {
			return JSON.parse(
				wiki.getTiddler(titles[name]).fields.text
			);
		}
	};
}

function testAcceptanceReplacesOnlyOneMessage(tw) {
	var f = fixture(tw);
	var proposal = f.proposal("first");

	assert(f.calls() === 1);
	assert(!f.registry("first").received);

	assert(
		f.manager.acceptEvent(
			f.journal,
			f.messageId("first"),
			proposal
		) === "accepted"
	);

	var record = f.manager.read(f.journal).record;

	assert(record.work !== null);
	assert(record.work.blocks.includes(f.titles.first));
	assert(!record.events[f.messageId("first")]);
	assert(Object.keys(record.events).length === 1);
	assert(record.events[f.messageId("second")].mode === "ready");
	assert(!f.registry("first").received);

	// Active materialization suppresses sibling delivery.
	assert(f.manager.pending(f.journal).length === 0);

	var results = f.manager.resume(f.journal);
	var pending = f.manager.pending(f.journal);

	assert(results.length === 1);
	assert(f.calls() === 1);
	assert(f.registry("first").received.data.name === "first");
	assert(pending.length === 1);
	assert(pending[0].id === f.messageId("second"));

	/*
	A completed input is not available for another acceptance.
	Its fingerprint remains evidence, not a new execution.
	*/
	assert(
		f.manager.acceptEvent(
			f.journal,
			f.messageId("first"),
			proposal
		) === "unavailable"
	);
}

function testLastRecipientClosesFlow(tw) {
	var f = fixture(tw);

	f.manager.acceptEvent(
		f.journal,
		f.messageId("first"),
		f.proposal("first")
	);
	f.manager.resume(f.journal);

	f.manager.acceptEvent(
		f.journal,
		f.messageId("second"),
		f.proposal("second")
	);

	var results = f.manager.resume(f.journal);

	assert(results.length === 1);
	assert(!f.wiki.getTiddler(f.journal));
	assert(f.calls() === 2);
	assert(f.registry("second").received.data.name === "second");
}

function testInterventionPreservesPendingMessage(tw) {
	var f = fixture(tw);
	var proposal = f.proposal("first");
	var before = f.wiki.getTiddler(f.journal).fields.text;

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.titles.first),
		{ caption: "intervention" }
	));

	throws(function () {
		f.manager.acceptEvent(
			f.journal,
			f.messageId("first"),
			proposal
		);
	}, "baseline has changed");

	assert(f.wiki.getTiddler(f.journal).fields.text === before);
	assert(f.manager.pending(f.journal).length === 2);
	assert(!f.registry("first").received);
}

function testWrongRecipientCannotConsumeMessage(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.journal).fields.text;

	throws(function () {
		f.manager.acceptEvent(
			f.journal,
			f.messageId("first"),
			f.proposal("second")
		);
	}, "another recipient");

	assert(f.wiki.getTiddler(f.journal).fields.text === before);
	assert(f.manager.pending(f.journal).length === 2);
}

function testInterruptedAcceptanceDoesNotRepeatHandler(tw) {
	var f = fixture(tw);
	var proposal = f.proposal("first");
	var originalApply = f.store.apply;
	var injected = false;

	f.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.journal && !injected) {
			injected = true;
			throw new Error("Interrupted after accepting recipient plan");
		}

		return result;
	};

	try {
		throws(function () {
			f.manager.acceptEvent(
				f.journal,
				f.messageId("first"),
				proposal
			);
		}, "Interrupted after accepting recipient plan");
	} finally {
		f.store.apply = originalApply;
	}

	assert(injected);
	assert(f.calls() === 1);
	assert(!f.registry("first").received);

	var preserved = f.manager.read(f.journal).record;

	assert(preserved.work !== null);
	assert(preserved.work.blocks.includes(f.titles.first));
	assert(!preserved.events[f.messageId("first")]);

	var restarted = f.service();
	var results = restarted.resume(f.journal);
	var pending = restarted.pending(f.journal);

	assert(results.length === 1);
	assert(f.calls() === 1);
	assert(f.registry("first").received.data.name === "first");
	assert(pending.length === 1);
	assert(pending[0].id === f.messageId("second"));
}

exports.run = function (tw) {
	var cases = [
		["flow acceptance: one message becomes one active plan", testAcceptanceReplacesOnlyOneMessage],
		["flow acceptance: final recipient closes the flow", testLastRecipientClosesFlow],
		["flow acceptance: intervention preserves pending work", testInterventionPreservesPendingMessage],
		["flow acceptance: another recipient cannot consume a message", testWrongRecipientCannotConsumeMessage],
		["flow acceptance: interrupted acceptance preserves the chosen result", testInterruptedAcceptanceDoesNotRepeatHandler]
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