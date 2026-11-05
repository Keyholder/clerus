/*\
title: $:/plugins/clerus/tests/core/materialization-barrier.js
type: application/javascript
module-type: library
\*/

"use strict";

var barriers = require(
	"$:/plugins/clerus/core/materialization-barrier.js"
);

var obligations = require(
	"$:/plugins/clerus/core/obligations.js"
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
	var owner = "$:/clerus/jobs/barrier-owner";

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "barrier-owner",
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

	var before = store.read(owner).fields;
	var after = Object.assign({}, before, {
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "proposed" }
			}
		})
	});

	var proposal = {
		version: 1,
		owner: {
			title: owner,
			executor: "barrier-owner",
			state: before
		},
		plan: {
			version: 1,
			effects: [
				stores.transition(owner, before, after)
			]
		}
	};

	var sequence = 0;

	var service = obligations.create({
		store: store,
		platform: platform,

		newId: function () {
			sequence++;

			return "barrier-test-" +
				String(sequence).padStart(12, "0");
		}
	});

	return {
		wiki: wiki,
		store: store,
		platform: platform,
		owner: owner,
		proposal: proposal,
		service: service,

		collect: function () {
			return barriers.collect({ store: store });
		}
	};
}

function testAcceptedPlanBlocksOwner(tw) {
	var f = fixture(tw);
	var journal = f.service.accept(f.proposal);

	var barrier = f.collect();

	assert(barrier.forJob(f.owner).join(",") === journal);
	assert(barrier.inspect().complete);
	assert(
		barrier.forJob("$:/clerus/jobs/another").length === 0
	);

	f.service.resume(journal);

	assert(f.collect().forJob(f.owner).length === 0);
}

function testUserCustodyPreservesBarrier(tw) {
	var f = fixture(tw);
	var journal = f.service.accept(f.proposal);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(journal),
		{ "clerus-custody": "user" }
	));

	assert(f.collect().forJob(f.owner).join(",") === journal);
}

function testOwnerConflictDoesNotEraseBarrier(tw) {
	var f = fixture(tw);
	var journal = f.service.accept(f.proposal);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.owner),
		{ caption: "intervention" }
	));

	assert(f.collect().forJob(f.owner).join(",") === journal);
	assert(f.collect().inspect().complete);
}

function testUnknownWalBlocksPersistentExecution(tw) {
	var f = fixture(tw);
	var foreignPlatform = f.platform === "browser" ? "node" : "browser";
	var title =
		"$:/clerus/wal/" + foreignPlatform + "/unknown-test";

	f.wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": "user",
		"clerus-wal-kind": "future-kind",
		text: JSON.stringify({
			version: 1,
			kind: "future-kind",
			platform: foreignPlatform
		})
	}));

	var barrier = f.collect();

	assert(!barrier.inspect().complete);
	assert(barrier.forJob(f.owner).join(",") === title);
	assert(
		barrier.forJob("$:/clerus/jobs/unrelated").join(",") === title
	);

	assert(
		barrier.forJob(
			"$:/temp/clerus/jobs/" + f.platform + "/ephemeral"
		).length === 0
	);
}

function testIncidentDoesNotBlock(tw) {
	var f = fixture(tw);

	f.wiki.addTiddler(new tw.Tiddler({
		title: "$:/clerus/wal/" + f.platform + "/incident-test",
		type: "application/json",
		"clerus-custody": "user",
		"clerus-wal-kind": "incident",
		text: JSON.stringify({
			version: 1,
			kind: "incident",
			platform: f.platform,
			incident: {
				owner: { title: f.owner },
				error: { message: "Historical failure" }
			}
		})
	}));

	var barrier = f.collect();

	assert(barrier.inspect().complete);
	assert(barrier.forJob(f.owner).length === 0);
}

function testSecondAcceptanceIsRejected(tw) {
	var f = fixture(tw);

	f.service.accept(f.proposal);

	throws(function () {
		f.service.accept(f.proposal);
	}, "unfinished materialization");

	assert(f.collect().forJob(f.owner).length === 1);
}

function testInspectionIsIsolated(tw) {
	var f = fixture(tw);
	var journal = f.service.accept(f.proposal);
	var barrier = f.collect();

	var view = barrier.inspect();
	view.blocked[0].obligations.length = 0;

	var titles = barrier.forJob(f.owner);
	titles.length = 0;

	assert(barrier.forJob(f.owner).join(",") === journal);
}

function testExtendedIncidentIsUnknownKnowledge(tw) {
	var f = fixture(tw);
	var title =
		"$:/clerus/wal/" + f.platform + "/extended-incident";

	f.wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": "user",
		"clerus-wal-kind": "incident",

		text: JSON.stringify({
			version: 1,
			kind: "incident",
			platform: f.platform,
			incident: {},
			future: { obligation: true }
		})
	}));

	var barrier = f.collect();

	assert(!barrier.inspect().complete);
	assert(barrier.forJob(f.owner).join(",") === title);
}

exports.run = function (tw) {
	var cases = [
		["barrier: accepted plan blocks its owner", testAcceptedPlanBlocksOwner],
		["barrier: user custody preserves the obligation", testUserCustodyPreservesBarrier],
		["barrier: owner conflict does not erase the obligation", testOwnerConflictDoesNotEraseBarrier],
		["barrier: unknown WAL prevents persistent authorization", testUnknownWalBlocksPersistentExecution],
		["barrier: historical incident does not block", testIncidentDoesNotBlock],
		["barrier: second acceptance is rejected", testSecondAcceptanceIsRejected],
		["barrier: inspection does not expose internal references", testInspectionIsIsolated],
		["barrier: extended incident envelope is unknown knowledge", testExtendedIncidentIsUnknownKnowledge]
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