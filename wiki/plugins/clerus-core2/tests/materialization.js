/*\
title: $:/plugins/clerus/core2/tests/materialization.js
type: application/javascript
module-type: library
\*/

"use strict";

var obligations = require(
	"$:/plugins/clerus/core2/obligations.js"
);
var plannedReactions = require(
	"$:/plugins/clerus/core2/planned-reaction.js"
);
var stores = require("$:/plugins/clerus/core2/store.js");

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
	var owner = "$:/clerus/jobs/materialization-owner";
	var target = "Core2 Materialization Target";

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "materialization-owner",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			}
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		text: "initial"
	}));

	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var proposal = plannedReactions.execute({
		store: store,
		title: owner,
		platform: platform,
		event: { type: "test" },

		handler: function (event, operational) {
			operational.get("charter").setStatus({
				phase: "completed"
			});
		}
	});

	var targetBefore = store.read(target).fields;
	var targetAfter = Object.assign({}, targetBefore, {
		text: "completed"
	});

	/*
		Place the external effect first so interruption can leave
		the owner at its original state.
	*/
	proposal.plan.effects.unshift(stores.transition(
		target,
		targetBefore,
		targetAfter
	));

	var sequence = 0;

	function service() {
		return obligations.create({
			store: store,
			platform: platform,

			newId: function () {
				sequence++;
				return "materialization-test-" +
					String(sequence).padStart(8, "0");
			}
		});
	}

	var manager = service();
	var journal = manager.accept(proposal);

	return {
		wiki: wiki,
		store: store,
		owner: owner,
		target: target,
		platform: platform,
		manager: manager,
		journal: journal,
		service: service,

		restoreJournalCustody: function () {
			wiki.addTiddler(new tw.Tiddler(
				wiki.getTiddler(journal),
				{ "clerus-custody": platform }
			));
		},

		ownerPhase: function () {
			return JSON.parse(
				wiki.getTiddler(owner).fields.text
			).charter.status.phase;
		}
	};
}

function testCompleteMaterialization(tw) {
	var f = fixture(tw);

	var results = f.manager.resume(f.journal);

	assert(results.length === 2);
	assert(f.wiki.getTiddlerText(f.target) === "completed");
	assert(f.ownerPhase() === "completed");
	assert(!f.wiki.getTiddler(f.journal));
}

function testInterruption(tw, afterWrite) {
	var f = fixture(tw);
	var originalApply = f.store.apply;
	var injected = false;
	var originalBody = f.wiki.getTiddler(f.journal).fields.text;

	f.store.apply = function (effect) {
		if (effect.title === f.target && !injected) {
			injected = true;

			if (afterWrite) {
				originalApply.call(this, effect);
			}

			throw new Error("Injected materialization interruption");
		}

		return originalApply.call(this, effect);
	};

	try {
		throws(function () {
			f.manager.resume(f.journal);
		}, "Injected materialization interruption");
	} finally {
		f.store.apply = originalApply;
	}

	assert(injected);
	assert(f.ownerPhase() === "initial");

	var paused = f.wiki.getTiddler(f.journal);

	assert(paused);
	assert(paused.fields["clerus-custody"] === "user");
	assert(paused.fields.text === originalBody);

	assert(
		f.wiki.getTiddlerText(f.target) ===
			(afterWrite ? "completed" : "initial")
	);

	f.restoreJournalCustody();

	// A new service instance uses only preserved authoritative state.
	var results = f.service().resume(f.journal);

	assert(
		results[0] ===
			(afterWrite ? "already-applied" : "applied")
	);

	assert(f.ownerPhase() === "completed");
	assert(f.wiki.getTiddlerText(f.target) === "completed");
	assert(!f.wiki.getTiddler(f.journal));
}

function testBeforeWrite(tw) {
	testInterruption(tw, false);
}

function testAfterWrite(tw) {
	testInterruption(tw, true);
}

function testConflictPreventsFurtherWrites(tw) {
	var f = fixture(tw);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.target),
		{ text: "intervention" }
	));

	throws(function () {
		f.manager.resume(f.journal);
	}, "conflict");

	assert(f.wiki.getTiddlerText(f.target) === "intervention");
	assert(f.ownerPhase() === "initial");
	assert(
		f.wiki.getTiddler(f.journal)
			.fields["clerus-custody"] === "user"
	);
}

function testOwnerInterventionPreventsWrites(tw) {
	var f = fixture(tw);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.owner),
		{ caption: "intervention" }
	));

	throws(function () {
		f.manager.resume(f.journal);
	}, "owner state has changed");

	assert(f.wiki.getTiddlerText(f.target) === "initial");
	assert(f.ownerPhase() === "initial");
	assert(
		f.wiki.getTiddler(f.owner).fields.caption === "intervention"
	);
}

exports.run = function (tw) {
	var cases = [
		["materialization: completion removes the obligation", testCompleteMaterialization],
		["materialization: interruption before write is recoverable", testBeforeWrite],
		["materialization: interruption after write is deduplicated", testAfterWrite],
		["materialization: conflict prevents further writes", testConflictPreventsFurtherWrites],
		["materialization: owner intervention is protected", testOwnerInterventionPreventsWrites]
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