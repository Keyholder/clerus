/*\
title: $:/plugins/clerus/tests/core/recovery.js
type: application/javascript
module-type: library
\*/

"use strict";

var obligations = require(
	"$:/plugins/clerus/core/obligations.js"
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

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var sequence = 0;

	var manager = obligations.create({
		store: store,
		platform: platform,

		newId: function () {
			sequence++;

			return "recovery-test-" +
				String(sequence).padStart(12, "0");
		}
	});

	function add(name) {
		var title = "$:/clerus/jobs/recovery-" + name;

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "recovery-test",
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: { phase: "initial" }
				}
			})
		}));

		var proposal = plannedReactions.execute({
			store: store,
			title: title,
			platform: platform,
			event: { type: "test" },

			handler: function (event, operational) {
				operational.get("charter").setStatus({
					phase: "completed"
				});
			}
		});

		return {
			owner: title,
			journal: manager.accept(proposal)
		};
	}

	return {
		wiki: wiki,
		platform: platform,
		manager: manager,
		add: add,

		phase: function (title) {
			return JSON.parse(
				wiki.getTiddler(title).fields.text
			).charter.status.phase;
		}
	};
}

function testIndependentRecovery(tw) {
	var f = fixture(tw);
	var first = f.add("first");
	var second = f.add("second");

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(first.owner),
		{ caption: "intervention" }
	));

	var report = f.manager.recover();

	var failed = report.entries.find(function (entry) {
		return entry.title === first.journal;
	});

	var completed = report.entries.find(function (entry) {
		return entry.title === second.journal;
	});

	assert(failed.status === "failed");
	assert(completed.status === "completed");

	assert(f.phase(first.owner) === "initial");
	assert(f.phase(second.owner) === "completed");

	assert(
		f.wiki.getTiddler(first.journal)
			.fields["clerus-custody"] === "user"
	);

	assert(!f.wiki.getTiddler(second.journal));
}

function testUserJournalWaitsForAuthorization(tw) {
	var f = fixture(tw);
	var work = f.add("paused");
	var body = f.wiki.getTiddler(work.journal).fields.text;

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(work.journal),
		{ "clerus-custody": "user" }
	));

	var first = f.manager.recover();

	assert(first.entries[0].status === "paused");
	assert(f.phase(work.owner) === "initial");
	assert(f.wiki.getTiddler(work.journal).fields.text === body);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(work.journal),
		{ "clerus-custody": f.platform }
	));

	var second = f.manager.recover();

	assert(second.entries[0].status === "completed");
	assert(f.phase(work.owner) === "completed");
	assert(!f.wiki.getTiddler(work.journal));
}

function testCustomUserAddress(tw) {
	var f = fixture(tw);
	var work = f.add("custom");
	var original = f.wiki.getTiddler(work.journal);

	var custom =
		"$:/clerus/wal/" + f.platform + "/user-prepared-work";

	f.wiki.addTiddler(new tw.Tiddler(
		original,
		{ title: custom }
	));

	f.wiki.deleteTiddler(work.journal);

	var report = f.manager.recover();

	assert(report.entries.length === 1);
	assert(report.entries[0].title === custom);
	assert(report.entries[0].status === "completed");
	assert(f.phase(work.owner) === "completed");
	assert(!f.wiki.getTiddler(custom));
}

function testUnknownKindPreservesBody(tw) {
	var f = fixture(tw);
	var title =
		"$:/clerus/wal/" + f.platform + "/unknown-work";
	var body = '{"version":1,"kind":"future"}';

	f.wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": f.platform,
		"clerus-wal-kind": "future",
		text: body
	}));

	var report = f.manager.recover();

	assert(report.entries[0].status === "unsupported");

	var current = f.wiki.getTiddler(title);

	assert(current.fields["clerus-custody"] === "user");
	assert(current.fields.text === body);
	assert(current.fields["clerus-wal-error"]);
}

function testIncidentsAreNotExecuted(tw) {
	var f = fixture(tw);
	var title =
		"$:/clerus/wal/" + f.platform + "/incident-history";
	var body = JSON.stringify({
		version: 1,
		kind: "incident",
		platform: f.platform,
		incident: {
			error: { message: "Historical failure" }
		}
	});

	f.wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": "user",
		"clerus-wal-kind": "incident",
		text: body
	}));

	var report = f.manager.recover();

	assert(report.entries[0].status === "historical");
	assert(f.wiki.getTiddler(title).fields.text === body);
}

function testIncidentMarkerDoesNotProveHistory(tw) {
	var f = fixture(tw);
	var title =
		"$:/clerus/wal/" + f.platform + "/mislabeled-history";

	var body = JSON.stringify({
		version: 1,
		kind: "flow",
		platform: f.platform,
		active: null,
		pending: [],
		seen: {},
		errors: []
	});

	f.wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": "user",
		"clerus-wal-kind": "incident",
		text: body
	}));

	var report = f.manager.recover();

	assert(report.entries.length === 1);
	assert(report.entries[0].status === "failed");

	var current = f.wiki.getTiddler(title);

	assert(current.fields.text === body);
	assert(current.fields["clerus-custody"] === "user");
}

function testDelegationRequiresMatchingEnvelope(tw) {
	var f = fixture(tw);
	var title =
		"$:/clerus/wal/" + f.platform + "/mislabeled-flow";

	var body = JSON.stringify({
		version: 1,
		kind: "plan",
		platform: f.platform,
		proposal: {}
	});

	f.wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": f.platform,
		"clerus-wal-kind": "flow",
		text: body
	}));

	var report = f.manager.recover();
	var entry = report.entries[0];

	assert(entry.title === title);
	assert(entry.status === "failed");

	var current = f.wiki.getTiddler(title);

	assert(current.fields.text === body);
	assert(current.fields["clerus-custody"] === "user");
	assert(current.fields["clerus-wal-kind"] === "flow");
	assert(current.fields["clerus-wal-error"]);
}

function testFutureDelegationIsNotExecution(tw) {
	var f = fixture(tw);

	["flow", "deferred"].forEach(function (kind) {
		var title =
			"$:/clerus/wal/" + f.platform + "/future-" + kind;

		var body = JSON.stringify({
			version: 2,
			kind: kind,
			platform: f.platform
		});

		f.wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": "user",
			"clerus-wal-kind": kind,
			text: body
		}));

		var before = JSON.stringify(
			f.wiki.getTiddler(title).fields
		);

		var report = f.manager.recover();

		var entry = report.entries.find(function (candidate) {
			return candidate.title === title;
		});

		assert(entry.status === "unsupported");
		assert(entry.error.indexOf("Unsupported WAL version") !== -1);

		assert(
			JSON.stringify(f.wiki.getTiddler(title).fields) === before
		);
	});
}

exports.run = function (tw) {
	var cases = [
		["recovery: one failed obligation does not block others", testIndependentRecovery],
		["recovery: user journal waits for authorization", testUserJournalWaitsForAuthorization],
		["recovery: user-prepared address is supported", testCustomUserAddress],
		["recovery: unknown kind preserves its body", testUnknownKindPreservesBody],
		["recovery: incidents remain historical", testIncidentsAreNotExecuted],
		["recovery: incident marker alone does not prove history", testIncidentMarkerDoesNotProveHistory],
		["recovery: delegation requires a matching envelope", testDelegationRequiresMatchingEnvelope],
		["recovery: future delegated versions remain untouched under user custody", testFutureDelegationIsNotExecution]
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