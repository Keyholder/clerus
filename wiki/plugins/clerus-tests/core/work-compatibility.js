/*\
title: $:/plugins/clerus/tests/core/work-compatibility.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var stores = require("$:/plugins/clerus/core/store.js");
var compatibility = require(
	"$:/plugins/clerus/core/work-compatibility.js"
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
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/compatibility-owner";
	var shared = "Compatibility Shared";
	var independent = "Compatibility Independent";
	var sequence = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "compatibility",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: {}
			}
		})
	}));

	[shared, independent].forEach(function (title) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			"clerus-custody": platform,
			text: "initial"
		}));
	});

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		newId: function () {
			sequence++;
			return "compatibility-test-" +
				String(sequence).padStart(12, "0");
		},
		resolveExecutor: function () {
			return function () {
				throw new Error("Unexpected executor invocation");
			};
		}
	});

	function transition(title) {
		var before = runtime.store.read(title).fields;

		return stores.transition(
			title,
			before,
			Object.assign({}, before, { caption: "completed" })
		);
	}

	function proposal(title) {
		return {
			version: 1,
			owner: {
				title: owner,
				executor: "compatibility",
				state: runtime.store.read(owner).fields
			},
			plan: {
				version: 1,
				effects: [transition(title)]
			}
		};
	}

	function work(title) {
		return {
			version: 2,
			id: "compatibility-work-000001",
			checks: [],
			transitions: [transition(title)],
			blocks: [],
			emits: []
		};
	}

	function publish(value) {
		var title =
			"$:/clerus/wal/" + platform + "/compatibility-v2";

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-wal-kind": "continuation",
			text: JSON.stringify({
				version: 2,
				kind: "continuation",
				platform: platform,
				work: value,
				events: {},
				evidence: {
					identities: {},
					receipts: {}
				},
				diagnostics: []
			})
		}));

		return title;
	}

	return {
		wiki: wiki,
		runtime: runtime,
		owner: owner,
		shared: shared,
		independent: independent,
		proposal: proposal,
		work: work,
		publish: publish
	};
}

function testV1AcceptanceSeesV2(tw) {
	var f = fixture(tw);

	f.publish(f.work(f.shared));

	throws(function () {
		f.runtime.obligations.accept(
			f.proposal(f.shared)
		);
	}, "Accepted work conflict");

	assert(
		f.runtime.store.read(f.shared).fields.caption === undefined
	);
}

function testRecoveryHasNoVersionWinner(tw) {
	var f = fixture(tw);

	var oldTitle = f.runtime.obligations.accept(
		f.proposal(f.shared)
	);
	var newTitle = f.publish(f.work(f.shared));

	var report = f.runtime.recover();

	[oldTitle, newTitle].forEach(function (title) {
		assert(report.entries.some(function (entry) {
			return (
				entry.title === title &&
				entry.status === "failed"
			);
		}));

		assert(
			f.wiki.getTiddler(title)
				.fields["clerus-custody"] === "user"
		);
	});

	assert(
		f.runtime.store.read(f.shared).fields.caption === undefined
	);
}

function testUnrelatedVersionsComplete(tw) {
	var f = fixture(tw);

	var oldTitle = f.runtime.obligations.accept(
		f.proposal(f.shared)
	);
	var newTitle = f.publish(f.work(f.independent));

	var report = f.runtime.recover();

	[oldTitle, newTitle].forEach(function (title) {
		assert(report.entries.some(function (entry) {
			return (
				entry.title === title &&
				entry.status === "completed"
			);
		}));

		assert(!f.wiki.tiddlerExists(title));
	});

	assert(
		f.runtime.store.read(f.shared).fields.caption === "completed"
	);
	assert(
		f.runtime.store.read(f.independent).fields.caption ===
			"completed"
	);
}

function testOwnerBaselineIsDependency(tw) {
	var f = fixture(tw);

	f.runtime.obligations.accept(
		f.proposal(f.shared)
	);

	var work = f.work(f.owner);

	throws(function () {
		compatibility.check({
			store: f.runtime.store,
			work: work
		});
	}, "Accepted work conflict");
}

function testControlSnapshotConflictsWithV1Write(tw) {
	var f = fixture(tw);
	var work = f.work(f.independent);

	work.checks = [{
		title: f.shared,
		state: f.runtime.store.read(f.shared).fields
	}];

	f.publish(work);

	throws(function () {
		f.runtime.obligations.accept(
			f.proposal(f.shared)
		);
	}, "Accepted work conflict");
}

function testPausedJournalStillConflicts(tw) {
	var f = fixture(tw);
	var title = f.publish(f.work(f.shared));

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(title),
		{ "clerus-custody": "user" }
	));

	throws(function () {
		f.runtime.obligations.accept(
			f.proposal(f.shared)
		);
	}, "Accepted work conflict");
}

exports.run = function (tw) {
	var cases = [
		["v1 acceptance sees v2 work", testV1AcceptanceSeesV2],
		["recovery has no version winner", testRecoveryHasNoVersionWinner],
		["unrelated versions complete", testUnrelatedVersionsComplete],
		["owner baseline is a dependency", testOwnerBaselineIsDependency],
		["control snapshot conflicts with v1 write", testControlSnapshotConflictsWithV1Write],
		["paused journal still conflicts", testPausedJournalStillConflicts]
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