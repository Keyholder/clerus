/*\
title: $:/plugins/clerus/tests/core/birth-proposals.js
type: application/javascript
module-type: library
\*/

"use strict";

var proposals = require(
	"$:/plugins/clerus/core/proposal-schema.js"
);
var continuations = require(
	"$:/plugins/clerus/core/continuations.js"
);
var stores = require("$:/plugins/clerus/core/store.js");

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
	var source = "$:/clerus/jobs/birth-proposal-source";
	var target = "$:/clerus/jobs/birth-proposal-target";

	wiki.addTiddler(new tw.Tiddler({
		title: source,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "source",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			target: target
		})
	}));

	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var sequence = 0;

	function newId() {
		sequence++;

		return "birth-proposal-generated-" +
			String(sequence).padStart(12, "0");
	}

	var manager = continuations.create({
		store: store,
		platform: platform,
		newId: newId
	});

	var messageId = "birth-proposal-message-0001";

	var journal = manager.accept({
		version: 2,
		id: newId(),
		checks: [],
		transitions: [],
		blocks: [],
		emits: [{
			id: messageId,
			event: {
				kind: "delivery",
				type: "order",
				establishing: true,
				recipient: {
					title: target,
					executor: "worker"
				},
				registry: {
					contract: {
						form: "contract",
						executor: "worker",
						temp: false
					}
				}
			}
		}]
	});

	manager.resume(journal);

	var created = {
		title: target,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "worker",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "running" }
			}
		})
	};

	return {
		wiki: wiki,
		store: store,
		platform: platform,
		target: target,
		manager: manager,
		journal: journal,
		messageId: messageId,

		proposal: {
			version: 1,
			owner: {
				title: target,
				executor: "worker",
				state: null
			},
			plan: {
				version: 1,
				effects: [
					stores.transition(target, null, created)
				],
				messages: []
			}
		}
	};
}

function testAcceptanceDoesNotCreateOwner(tw) {
	var f = fixture(tw);

	assert(
		f.manager.acceptEvent(
			f.journal,
			f.messageId,
			f.proposal
		) === "accepted"
	);

	assert(!f.wiki.getTiddler(f.target));

	var record = f.manager.read(f.journal).record;

	assert(record.work !== null);
	assert(!Object.prototype.hasOwnProperty.call(
		record.events,
		f.messageId
	));

	var birth = record.work.transitions.find(function (effect) {
		return effect.title === f.target;
	});

	assert(birth);
	assert(birth.before === null);
	assert(birth.after["clerus-executor"] === "worker");

	var results = f.manager.resume(f.journal);

	assert(results.length === 1);
	assert(results[0] === "applied");
	assert(f.wiki.getTiddler(f.target));
	assert(!f.wiki.getTiddler(f.journal));
}

function testMissingBirthEffectIsRejected(tw) {
	var f = fixture(tw);
	f.proposal.plan.effects = [];

	throws(function () {
		proposals.validate(f.proposal);
	}, "must create its owner");

	assert(f.manager.pending(f.journal).length === 1);
}

function testOccupiedTargetPreservesMessage(tw) {
	var f = fixture(tw);

	f.wiki.addTiddler(new tw.Tiddler({
		title: f.target,
		text: "intervention"
	}));

	var before = f.wiki.getTiddler(f.journal).fields.text;

	throws(function () {
		f.manager.acceptEvent(
			f.journal,
			f.messageId,
			f.proposal
		);
	}, "baseline has changed");

	assert(f.wiki.getTiddler(f.journal).fields.text === before);
	assert(f.wiki.getTiddlerText(f.target) === "intervention");
}

function testBirthRecoversAfterActualWrite(tw) {
	var f = fixture(tw);

	f.manager.acceptEvent(
		f.journal,
		f.messageId,
		f.proposal
	);

	var originalApply = f.store.apply;
	var injected = false;

	f.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.target && !injected) {
			injected = true;
			throw new Error("Interrupted after persistent birth");
		}

		return result;
	};

	try {
		throws(function () {
			f.manager.resume(f.journal);
		}, "Interrupted after persistent birth");
	} finally {
		f.store.apply = originalApply;
	}

	assert(f.wiki.getTiddler(f.target));
	assert(
		f.wiki.getTiddler(f.journal)
			.fields["clerus-custody"] === "user"
	);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.journal),
		{ "clerus-custody": f.platform }
	));

	var results = f.manager.resume(f.journal);
	assert(results.length === 1);
	assert(results[0] === "already-applied");
	assert(!f.wiki.getTiddler(f.journal));

	var registry = JSON.parse(
		f.wiki.getTiddler(f.target).fields.text
	);

	assert(registry.charter.status.phase === "running");
}

exports.run = function (tw) {
	var cases = [
		["birth proposals: acceptance precedes owner creation", testAcceptanceDoesNotCreateOwner],
		["birth proposals: owner creation is mandatory", testMissingBirthEffectIsRejected],
		["birth proposals: occupied target preserves pending work", testOccupiedTargetPreservesMessage],
		["birth proposals: recorded birth resumes after actual write", testBirthRecoversAfterActualWrite]
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