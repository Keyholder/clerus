/*\
title: $:/plugins/clerus/tests/core/birth-proposals.js
type: application/javascript
module-type: library
\*/

"use strict";

var proposals = require(
	"$:/plugins/clerus/core/proposal-schema.js"
);
var flows = require(
	"$:/plugins/clerus/core/flow-obligations.js"
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

	var manager = flows.create({
		store: store,
		platform: platform,
		newId: function () {
			return "birth-proposal-flow-identity";
		}
	});

	var messageId = "birth-proposal-message-0001";

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
			messages: [{
				version: 1,
				kind: "official-message",
				id: messageId,
				platform: platform,
				type: "order",
				establishing: true,
				source: { title: source, executor: "source" },
				recipient: { title: target, executor: "worker" },
				registry: {
					contract: {
						form: "contract",
						executor: "worker",
						temp: false
					}
				}
			}]
		}
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
		f.manager.accept(
			f.journal,
			f.messageId,
			f.proposal
		) === "accepted"
	);

	assert(!f.wiki.getTiddler(f.target));

	var record = f.manager.read(f.journal).record;

	assert(record.active.owner.state === null);

	assert(f.manager.resume(f.journal).length === 0);
	assert(f.wiki.getTiddler(f.target));
	assert(!f.wiki.getTiddler(f.journal));
}

function testMissingBirthEffectIsRejected(tw) {
	var f = fixture(tw);
	f.proposal.plan.effects = [];

	throws(function () {
		proposals.validate(f.proposal, { allowMessages: true });
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
		f.manager.accept(
			f.journal,
			f.messageId,
			f.proposal
		);
	}, "owner state has changed");

	assert(f.wiki.getTiddler(f.journal).fields.text === before);
	assert(f.wiki.getTiddlerText(f.target) === "intervention");
}

function testBirthRecoversAfterActualWrite(tw) {
	var f = fixture(tw);

	f.manager.accept(
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

	assert(f.manager.resume(f.journal).length === 0);
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