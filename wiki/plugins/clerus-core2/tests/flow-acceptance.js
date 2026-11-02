/*\
title: $:/plugins/clerus/core/tests/flow-acceptance.js
type: application/javascript
module-type: library
\*/

"use strict";

var flows = require(
	"$:/plugins/clerus/core/flow-obligations.js"
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

	function service() {
		return flows.create({
			store: store,
			platform: platform,
			newId: function () {
				return "accept-flow-root-identity";
			}
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

	var title = manager.register({
		version: 1,
		owner: {
			title: titles.root,
			executor: "root",
			state: store.read(titles.root).fields
		},
		plan: {
			version: 1,
			effects: [],
			messages: [
				message("first"),
				message("second")
			]
		}
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
		f.manager.accept(
			f.journal,
			f.messageId("first"),
			proposal
		) === "accepted"
	);

	var record = f.manager.read(f.journal).record;

	assert(record.active.owner.title === f.titles.first);
	assert(record.pending.length === 1);
	assert(record.pending[0].id === f.messageId("second"));
	assert(!f.registry("first").received);

	// Active materialization suppresses delivery of pending siblings.
	assert(f.manager.pending(f.journal).length === 0);

	var pending = f.manager.resume(f.journal);

	assert(f.calls() === 1);
	assert(f.registry("first").received.data.name === "first");
	assert(pending.length === 1);
	assert(pending[0].id === f.messageId("second"));

	assert(
		f.manager.accept(
			f.journal,
			f.messageId("first"),
			proposal
		) === "already-completed"
	);
}

function testLastRecipientClosesFlow(tw) {
	var f = fixture(tw);

	f.manager.accept(
		f.journal,
		f.messageId("first"),
		f.proposal("first")
	);
	f.manager.resume(f.journal);

	f.manager.accept(
		f.journal,
		f.messageId("second"),
		f.proposal("second")
	);

	var pending = f.manager.resume(f.journal);

	assert(pending.length === 0);
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
		f.manager.accept(
			f.journal,
			f.messageId("first"),
			proposal
		);
	}, "owner state has changed");

	assert(f.wiki.getTiddler(f.journal).fields.text === before);
	assert(f.manager.pending(f.journal).length === 2);
	assert(!f.registry("first").received);
}

function testWrongRecipientCannotConsumeMessage(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.journal).fields.text;

	throws(function () {
		f.manager.accept(
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
			f.manager.accept(
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

	assert(preserved.active !== null);
	assert(preserved.active.owner.title === f.titles.first);

	// A fresh manager resumes the recorded result, not the handler.
	var pending = f.service().resume(f.journal);

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