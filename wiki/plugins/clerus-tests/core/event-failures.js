/*\
title: $:/plugins/clerus/tests/core/event-failures.js
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
var barriers = require(
	"$:/plugins/clerus/core/materialization-barrier.js"
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
		root: "$:/clerus/jobs/failure-flow-root",
		first: "$:/clerus/jobs/failure-flow-first",
		second: "$:/clerus/jobs/failure-flow-second"
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

		return "failure-continuation-" +
			String(sequence).padStart(12, "0");
	}

	function service() {
		return continuations.create({
			store: store,
			platform: platform,
			newId: newId
		});
	}

	function message(name) {
		return {
			version: 1,
			kind: "official-message",
			id: "failure-flow-message-" + name,
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
				input: { form: "memo", data: name }
			}
		};
	}

	var manager = service();

	var journal = manager.accept({
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

	manager.resume(journal);

	return {
		wiki: wiki,
		store: store,
		platform: platform,
		titles: titles,
		manager: manager,
		journal: journal,
		service: service,

		recipient: function (name) {
			return { title: titles[name], executor: name };
		},

		id: function (name) {
			return message(name).id;
		},

		completeSecond: function () {
			var proposal = plannedReactions.execute({
				store: store,
				title: titles.second,
				platform: platform,
				event: { type: "order" },
				incoming: message("second").registry,

				handler: function (event, operational, incoming) {
					incoming.destroy("input");
				}
			});

			manager.acceptEvent(
				journal,
				message("second").id,
				proposal
			);

			return manager.resume(journal);
		}
	};
}

function testSiblingContinuesAndErrorsRemain(tw) {
	var f = fixture(tw);
	var firstBefore = f.wiki.getTiddler(f.titles.first).fields.text;

	var failure = f.manager.failEvent(
		f.journal,
		f.id("first"),
		f.recipient("first"),
		new Error("Recipient failed")
	);

	assert(failure === "paused");

	var pending = f.manager.pending(f.journal);

	assert(pending.length === 1);
	assert(pending[0].id === f.id("second"));

	var ongoing = f.manager.read(f.journal).record;

	assert(ongoing.diagnostics.length === 1);
	assert(ongoing.work === null);
	assert(ongoing.events[f.id("first")].mode === "paused");
	assert(
		f.wiki.getTiddler(f.journal)
			.fields["clerus-custody"] === f.platform
	);

	// Destroying incoming memo needs no operational transition.
	assert(f.completeSecond().length === 0);

	var journal = f.wiki.getTiddler(f.journal);
	var completed = JSON.parse(journal.fields.text);

	assert(journal.fields["clerus-custody"] === "user");
	assert(completed.work === null);
	assert(Object.keys(completed.events).length === 1);
	assert(completed.events[f.id("first")].mode === "paused");
	assert(
		completed.events[f.id("first")]
			.event.registry.input.data === "first"
	);
	assert(completed.diagnostics.length === 1);
	assert(
		completed.diagnostics[0].error.message === "Recipient failed"
	);
	assert(
		f.wiki.getTiddler(f.titles.first).fields.text === firstBefore
	);

	/*
	A paused event retains its recipient, but is not active
	materialization and therefore creates no material barrier.
	*/
	var barrier = barriers.collect({ store: f.store });

	assert(barrier.inspect().complete);
	assert(barrier.forJob(f.titles.first).length === 0);
	assert(barrier.forJob(f.titles.second).length === 0);
}

function testWrongRecipientCannotFailMessage(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.journal).fields.text;

	throws(function () {
		f.manager.failEvent(
			f.journal,
			f.id("first"),
			f.recipient("second"),
			new Error("Not its failure")
		);
	}, "another recipient");

	assert(f.wiki.getTiddler(f.journal).fields.text === before);
}

function testRepeatedFailureDoesNotDuplicateEvidence(tw) {
	var f = fixture(tw);

	f.manager.failEvent(
		f.journal,
		f.id("first"),
		f.recipient("first"),
		new Error("First failure")
	);

	var repeated = f.manager.failEvent(
		f.journal,
		f.id("first"),
		f.recipient("first"),
		new Error("Repeated failure")
	);

	assert(repeated === "unavailable");
	assert(
		f.manager.read(f.journal).record.diagnostics.length === 1
	);
}

function testInterruptedFailureRegistration(tw) {
	var f = fixture(tw);
	var originalApply = f.store.apply;
	var injected = false;

	f.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.journal && !injected) {
			injected = true;
			throw new Error("Interrupted failure registration");
		}

		return result;
	};

	try {
		throws(function () {
			f.manager.failEvent(
				f.journal,
				f.id("first"),
				f.recipient("first"),
				new Error("Recipient failed")
			);
		}, "Interrupted failure registration");
	} finally {
		f.store.apply = originalApply;
	}

	var manager = f.service();

	manager.resume(f.journal);

	var pending = manager.pending(f.journal);
	var record = manager.read(f.journal).record;

	assert(pending.length === 1);
	assert(pending[0].id === f.id("second"));
	assert(record.events[f.id("first")].mode === "paused");
	assert(record.diagnostics.length === 1);
}

exports.run = function (tw) {
	var cases = [
		["flow failures: siblings complete and diagnostics remain", testSiblingContinuesAndErrorsRemain],
		["flow failures: recipient identity is checked", testWrongRecipientCannotFailMessage],
		["flow failures: repeated failure does not duplicate evidence", testRepeatedFailureDoesNotDuplicateEvidence],
		["flow failures: interrupted registration preserves the result", testInterruptedFailureRegistration]
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