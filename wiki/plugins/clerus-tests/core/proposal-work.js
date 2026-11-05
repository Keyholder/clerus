/*\
title: $:/plugins/clerus/tests/core/proposal-work.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var planned = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
var adapter = require(
	"$:/plugins/clerus/core/proposal-work.js"
);
var stores = require("$:/plugins/clerus/core/store.js");
var barriers = require(
	"$:/plugins/clerus/core/materialization-barrier.js"
);

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

	return caught;
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/proposal-work-owner";
	var target = "Proposal Work Target";
	var sequence = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "proposal-work",
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

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		newId: function () {
			sequence++;
			return "proposal-work-id-" +
				String(sequence).padStart(12, "0");
		},
		resolveExecutor: function () {
			return function () {
				throw new Error(
					"Recovery must not invoke an executor"
				);
			};
		}
	});

	function reaction(handler) {
		return planned.execute({
			store: runtime.store,
			title: owner,
			platform: platform,
			event: { type: "test" },
			newId: runtime.newId,
			handler: handler
		});
	}

	function externalProposal() {
		var proposal = reaction(function () {});
		var before = runtime.store.read(target).fields;

		proposal.plan.effects.push(stores.transition(
			target,
			before,
			Object.assign({}, before, {
				text: "completed"
			})
		));

		return proposal;
	}

	return {
		wiki: wiki,
		platform: platform,
		owner: owner,
		target: target,
		runtime: runtime,
		reaction: reaction,
		externalProposal: externalProposal
	};
}

function testOwnerTransition(tw) {
	var f = fixture(tw);

	var proposal = f.reaction(function (event, operational) {
		operational.get("charter").setStatus({
			phase: "completed"
		});
	});

	var work = adapter.convert(
		proposal,
		"proposal-work-conversion-01"
	);

	assert(work.checks.length === 0);
	assert(work.blocks.join(",") === f.owner);
	assert(work.transitions.length === 1);

	var title = f.runtime.continuations.accept(work);

	/*
		Acceptance records the obligation, not its material effects.
	*/
	assert(
		JSON.parse(f.wiki.getTiddlerText(f.owner))
			.charter.status.phase === "initial"
	);

	assert(
		barriers.collect({
			store: f.runtime.store
		}).forJob(f.owner).indexOf(title) !== -1
	);

	var report = f.runtime.recover();

	assert(report.entries.some(function (entry) {
		return entry.title === title && entry.status === "completed";
	}));

	assert(
		JSON.parse(f.wiki.getTiddlerText(f.owner))
			.charter.status.phase === "completed"
	);
}

function testUnchangedOwnerBecomesCheck(tw) {
	var f = fixture(tw);
	var work = adapter.convert(
		f.externalProposal(),
		"proposal-work-control-0001"
	);

	assert(work.checks.length === 1);
	assert(work.checks[0].title === f.owner);
	assert(work.blocks.join(",") === f.owner);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.owner),
		{ caption: "intervention" }
	));

	throws(function () {
		f.runtime.continuations.accept(work);
	}, "Work check conflict");

	assert(f.wiki.getTiddlerText(f.target) === "initial");

	assert(
		f.runtime.store.snapshot().materialized.every(
			function (fields) {
				return (
					fields["clerus-wal-kind"] !== "continuation"
				);
			}
		)
	);
}

function testEmptyReaction(tw) {
	var f = fixture(tw);
	var proposal = f.reaction(function () {});

	assert(
		adapter.convert(
			proposal,
			"proposal-work-empty-00001"
		) === null
	);
}

function testUncertainRegistration(tw) {
	var f = fixture(tw);
	var work = adapter.convert(
		f.externalProposal(),
		"proposal-work-uncertain-01"
	);

	var originalApply = f.runtime.store.apply;
	var injected = false;
	var error;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (
			!injected &&
			effect.after &&
			effect.after["clerus-wal-kind"] === "continuation"
		) {
			injected = true;
			throw new Error("Interrupted after registration");
		}

		return result;
	};

	try {
		error = throws(function () {
			f.runtime.continuations.accept(work);
		}, "Interrupted after registration");
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(error.acceptanceUncertain);
	assert(error.obligationTitle);
	assert(f.wiki.tiddlerExists(error.obligationTitle));
	assert(f.wiki.getTiddlerText(f.target) === "initial");

	var report = f.runtime.recover();

	assert(report.entries.some(function (entry) {
		return (
			entry.title === error.obligationTitle &&
			entry.status === "completed"
		);
	}));

	assert(f.wiki.getTiddlerText(f.target) === "completed");
}

function testSecondAcceptance(tw) {
	var f = fixture(tw);
	var proposal = f.externalProposal();

	var first = adapter.convert(
		proposal,
		"proposal-work-first-00001"
	);

	var second = adapter.convert(
		proposal,
		"proposal-work-second-0001"
	);

	f.runtime.continuations.accept(first);

	throws(function () {
		f.runtime.continuations.accept(second);
	}, "Accepted work conflict");
}

function testSameIdentityIsNotAcceptedTwice(tw) {
	var f = fixture(tw);
	var work = adapter.convert(
		f.externalProposal(),
		"proposal-work-duplicate-01"
	);

	f.runtime.continuations.accept(work);

	throws(function () {
		f.runtime.continuations.accept(work);
	}, "Work identity has another journal");
}

exports.run = function (tw) {
	var cases = [
		["owner transition preserves reaction semantics", testOwnerTransition],
		["unchanged owner becomes a control snapshot", testUnchangedOwnerBecomesCheck],
		["empty reaction creates no work", testEmptyReaction],
		["uncertain registration preserves the obligation", testUncertainRegistration],
		["second conflicting acceptance is rejected", testSecondAcceptance],
		["same work identity is not accepted twice", testSameIdentityIsNotAcceptedTwice]
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