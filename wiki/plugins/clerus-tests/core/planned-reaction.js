/*\
title: $:/plugins/clerus/tests/core/planned-reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

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

function fixture(tw, custody) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/planned-reaction-owner";

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": custody || platform,
		"clerus-executor": "planned-reaction",
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
		title: title,

		execute: function (handler, incoming) {
			return plannedReactions.execute({
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

function testSuccessReturnsOnlyProposal(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.title).fields.text;
	var saved;

	var proposal = f.execute(function (event, operational) {
		assert(Object.isFrozen(event));
		assert(event.title === f.title);

		saved = operational.get("note");

		saved.setData({ value: 2 });

		operational.get("charter").setStatus({
			phase: "proposed"
		});

		assert(saved.data().value === 2);
		assert(f.wiki.getTiddler(f.title).fields.text === before);
	});

	assert(proposal.version === 1);
	assert(proposal.owner.title === f.title);
	assert(proposal.owner.executor === "planned-reaction");
	assert(proposal.owner.state.text === before);
	assert(proposal.plan.effects.length === 1);

	var after = JSON.parse(proposal.plan.effects[0].after.text);

	assert(after.note.data.value === 2);
	assert(after.charter.status.phase === "proposed");
	assert(f.wiki.getTiddler(f.title).fields.text === before);

	throws(function () {
		saved.data();
	}, "closed");
}

function testFailureDiscardsAllWork(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.title).fields.text;
	var saved;

	throws(function () {
		f.execute(function (event, operational) {
			saved = operational.get("note");
			saved.setData({ value: 99 });

			operational.get("charter").setStatus({
				phase: "must not escape"
			});

			throw new Error("Rejected reaction");
		});
	}, "Rejected reaction");

	assert(f.wiki.getTiddler(f.title).fields.text === before);

	throws(function () {
		saved.setData({ value: 100 });
	}, "closed");
}

function testIncomingPlacementIsProposed(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.title).fields.text;

	var proposal = f.execute(function (event, operational, incoming) {
		incoming.get("input").setData({ value: 43 });

		incoming.move("input", operational, "received");
	}, {
		input: {
			form: "memo",
			data: { value: 42 }
		}
	});

	assert(f.wiki.getTiddler(f.title).fields.text === before);

	var after = JSON.parse(proposal.plan.effects[0].after.text);

	assert(after.received.data.value === 43);
}

function testUnresolvedInputRejectsProposal(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.title).fields.text;

	throws(function () {
		f.execute(function (event, operational) {
			operational.get("note").setData({ value: 2 });
		}, {
			input: { form: "memo", data: 42 }
		});
	}, "unresolved");

	assert(f.wiki.getTiddler(f.title).fields.text === before);
}

function testUnsentOutputRejectsProposal(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.title).fields.text;

	throws(function () {
		f.execute(function (event, operational) {
			var outgoing = operational.outgoing();

			operational.copy("note", outgoing, "unsent");
			operational.get("note").setData({ value: 2 });
		});
	}, "unsent documents");

	assert(f.wiki.getTiddler(f.title).fields.text === before);
}

function testAsyncResultClosesAccess(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.title).fields.text;
	var saved;

	throws(function () {
		f.execute(function (event, operational) {
			saved = operational.get("note");
			saved.setData({ value: 2 });

			return Promise.resolve();
		});
	}, "must be synchronous");

	assert(f.wiki.getTiddler(f.title).fields.text === before);

	throws(function () {
		saved.data();
	}, "closed");
}

function testRestrictedReactionCanCompleteWithoutWrites(tw) {
	var f = fixture(tw, "user");

	var proposal = f.execute(function (event, operational, incoming) {
		assert(operational.get("note").data().value === 1);

		throws(function () {
			operational.get("note").setData({ value: 2 });
		}, "not writable");

		incoming.destroy("input");
	}, {
		input: { form: "memo", data: 42 }
	});

	assert(proposal.plan.effects.length === 0);
}

exports.run = function (tw) {
	var cases = [
		["planned reaction: success returns an isolated proposal", testSuccessReturnsOnlyProposal],
		["planned reaction: failure discards all work", testFailureDiscardsAllWork],
		["planned reaction: incoming placement remains virtual", testIncomingPlacementIsProposed],
		["planned reaction: unresolved input rejects proposal", testUnresolvedInputRejectsProposal],
		["planned reaction: unsent output rejects proposal", testUnsentOutputRejectsProposal],
		["planned reaction: asynchronous return closes access", testAsyncResultClosesAccess],
		["planned reaction: restricted execution can finish without writes", testRestrictedReactionCanCompleteWithoutWrites]
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