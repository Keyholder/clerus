/*\
title: $:/plugins/clerus/core2/tests/obligation-acceptance.js
type: application/javascript
module-type: library
\*/

"use strict";

var plannedReactions = require(
	"$:/plugins/clerus/core2/planned-reaction.js"
);
var obligations = require(
	"$:/plugins/clerus/core2/obligations.js"
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

function fixture(tw, change) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/acceptance-owner";

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "acceptance-owner",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			}
		})
	}));

	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var proposal = plannedReactions.execute({
		store: store,
		title: title,
		platform: platform,
		event: { type: "test" },

		handler: function (event, operational) {
			if (change !== false) {
				operational.get("charter").setStatus({
					phase: "proposed"
				});
			}
		}
	});

	var sequence = 0;

	var service = obligations.create({
		store: store,
		platform: platform,

		newId: function () {
			sequence++;

			return "acceptance-test-" +
				String(sequence).padStart(8, "0");
		}
	});

	function journals() {
		var result = [];

		wiki.each(function (tiddler, candidate) {
			if (tiddler.fields["clerus-wal-kind"] === "plan") {
				result.push(candidate);
			}
		});

		return result;
	}

	return {
		wiki: wiki,
		store: store,
		title: title,
		platform: platform,
		proposal: proposal,
		service: service,
		journals: journals
	};
}

function testAcceptedBeforeMaterialization(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.title).fields.text;

	var journal = f.service.accept(f.proposal);

	assert(typeof journal === "string");
	assert(f.journals().length === 1);
	assert(f.wiki.getTiddler(f.title).fields.text === before);

	var record = JSON.parse(
		f.wiki.getTiddler(journal).fields.text
	);

	assert(record.kind === "plan");
	assert(record.proposal.plan.effects.length === 1);
	assert(record.proposal.owner.title === f.title);
}

function testOwnerInterventionRejectsAcceptance(tw) {
	var f = fixture(tw);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.title),
		{ caption: "intervention" }
	));

	throws(function () {
		f.service.accept(f.proposal);
	}, "owner state has changed");

	assert(f.journals().length === 0);
}

function testTargetConflictRejectsWholeProposal(tw) {
	var f = fixture(tw);
	var target = "Acceptance External Target";

	f.wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": f.platform,
		text: "intervention"
	}));

	f.proposal.plan.effects.push(stores.transition(
		target,
		{
			title: target,
			"clerus-custody": f.platform,
			text: "expected"
		},
		{
			title: target,
			"clerus-custody": f.platform,
			text: "proposed"
		}
	));

	var before = f.wiki.getTiddler(f.title).fields.text;

	throws(function () {
		f.service.accept(f.proposal);
	}, "conflict");

	assert(f.journals().length === 0);
	assert(f.wiki.getTiddler(f.title).fields.text === before);
	assert(f.wiki.getTiddlerText(target) === "intervention");
}

function testRepeatedTargetsAreRejected(tw) {
	var f = fixture(tw);

	f.proposal.plan.effects.push(f.proposal.plan.effects[0]);

	throws(function () {
		f.service.accept(f.proposal);
	}, "Repeated proposal target");

	assert(f.journals().length === 0);
}

function testUnknownPlanFieldsAreRejected(tw) {
	var f = fixture(tw);

	f.proposal.plan.messages = [];

	throws(function () {
		f.service.accept(f.proposal);
	}, "Unsupported fields");

	assert(f.journals().length === 0);
}

function testEmptyProposalCreatesNoObligation(tw) {
	var f = fixture(tw, false);

	assert(f.service.accept(f.proposal) === null);
	assert(f.journals().length === 0);
}

exports.run = function (tw) {
	var cases = [
		["acceptance: obligation precedes materialization", testAcceptedBeforeMaterialization],
		["acceptance: owner intervention prevents registration", testOwnerInterventionRejectsAcceptance],
		["acceptance: target conflict rejects the whole proposal", testTargetConflictRejectsWholeProposal],
		["acceptance: repeated targets are rejected", testRepeatedTargetsAreRejected],
		["acceptance: unknown effect categories are not ignored", testUnknownPlanFieldsAreRejected],
		["acceptance: empty proposal creates no WAL", testEmptyProposalCreatesNoObligation]
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