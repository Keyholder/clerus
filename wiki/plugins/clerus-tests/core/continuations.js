/*\
title: $:/plugins/clerus/tests/core/continuations.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var stores = require("$:/plugins/clerus/core/store.js");
var barriers = require(
	"$:/plugins/clerus/core/materialization-barrier.js"
);
var retention = require("$:/plugins/clerus/core/retention.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw, retention) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var first = "$:/clerus/jobs/continuation-first";
	var second = "$:/clerus/jobs/continuation-second";
	var referenced = "$:/clerus/jobs/continuation-referenced";
	var sequence = 0;

	[first, second, referenced].forEach(function (title) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "continuation-test",
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: { phase: "initial" }
				}
			})
		}));
	});

	function runtime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: function () {
				sequence++;
				return "continuation-test-" +
					String(sequence).padStart(12, "0");
			},
			resolveExecutor: function () {
				return function () {
					throw new Error(
						"Material recovery must not invoke executors"
					);
				};
			},
			continuationRetention: retention
		});
	}

	var current = runtime();

	function work(id) {
		return {
			version: 2,
			id: id,
			checks: [],
			transitions: [first, second].map(function (title) {
				var before = current.store.read(title).fields;

				return stores.transition(
					title,
					before,
					Object.assign({}, before, {
						text: JSON.stringify({
							charter: {
								form: "charter",
								status: { phase: "completed" }
							},
							reference: referenced
						})
					})
				);
			}),
			blocks: [],
			emits: []
		};
	}

	function publish(name, value, custody) {
		var title = "$:/clerus/wal/" + platform + "/" + name;

		var record = {
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
		};

		if (retention && retention.delay > 0) {
			record.retainUntil = retention.now() + retention.delay;
		}

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": custody || platform,
			"clerus-wal-kind": "continuation",
			text: JSON.stringify(record)
		}));

		return title;
	}

	return {
		wiki: wiki,
		platform: platform,
		first: first,
		second: second,
		referenced: referenced,
		runtime: current,
		restart: runtime,
		work: work,
		publish: publish
	};
}

function testRuntimeRecovery(tw) {
	var f = fixture(tw);
	var title = f.publish(
		"completion",
		f.work("continuation-completion-0001")
	);

	var report = f.runtime.recover();
	var entry = report.entries.find(function (entry) {
		return entry.title === title;
	});

	assert(entry.status === "completed");
	assert(entry.results.length === 2);
	assert(!f.wiki.tiddlerExists(title));

	assert(
		JSON.parse(f.wiki.getTiddlerText(f.second))
			.charter.status.phase === "completed"
	);
}

function testUserCustodyPreservesPerspective(tw) {
	var f = fixture(tw);
	var title = f.publish(
		"paused",
		f.work("continuation-paused-000001"),
		"user"
	);

	var barrier = barriers.collect({
		store: f.runtime.store
	});

	assert(barrier.inspect().complete);
	assert(barrier.forJob(f.first).indexOf(title) !== -1);
	assert(barrier.forJob(f.second).indexOf(title) !== -1);

	var view = retention.evaluate({
		jobs: f.runtime.readJobs(),
		tiddlers: f.runtime.store.snapshot().materialized
	});

	assert(view.complete);
	assert(view.retained.some(function (entry) {
		return (
			entry.title === f.referenced &&
			entry.reasons.some(function (reason) {
				return (
					reason.kind === "planned-operational-reference" &&
					reason.wal === title
				);
			})
		);
	}));

	var report = f.runtime.recover();

	assert(report.entries.some(function (entry) {
		return entry.title === title && entry.status === "paused";
	}));

	assert(
		JSON.parse(f.wiki.getTiddlerText(f.first))
			.charter.status.phase === "initial"
	);
}

function testInterruptedRecovery(tw) {
	var f = fixture(tw);
	var title = f.publish(
		"interrupted",
		f.work("continuation-interrupted-01")
	);
	var originalBody = f.wiki.getTiddlerText(title);
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.first && !injected) {
			injected = true;
			throw new Error("Interrupted after first job write");
		}

		return result;
	};

	try {
		var report = f.runtime.recover();

		assert(report.entries.some(function (entry) {
			return entry.title === title && entry.status === "failed";
		}));
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(f.wiki.getTiddlerText(title) === originalBody);
	assert(
		f.wiki.getTiddler(title).fields["clerus-custody"] === "user"
	);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(title),
		{ "clerus-custody": f.platform }
	));

	var restarted = f.restart();
	var recovered = restarted.recover();
	var entry = recovered.entries.find(function (entry) {
		return entry.title === title;
	});

	assert(entry.status === "completed");
	assert(entry.results[0] === "already-applied");
	assert(entry.results[1] === "applied");
	assert(!f.wiki.tiddlerExists(title));
}

function testConflictingJournalsHaveNoWinner(tw) {
	var f = fixture(tw);

	var firstWal = f.publish(
		"conflict-a",
		f.work("continuation-conflict-0001")
	);

	var secondWal = f.publish(
		"conflict-b",
		f.work("continuation-conflict-0002")
	);

	var report = f.runtime.recover();

	[firstWal, secondWal].forEach(function (title) {
		assert(report.entries.some(function (entry) {
			return entry.title === title && entry.status === "failed";
		}));

		assert(
			f.wiki.getTiddler(title).fields["clerus-custody"] === "user"
		);
	});

	assert(
		JSON.parse(f.wiki.getTiddlerText(f.first))
			.charter.status.phase === "initial"
	);
}

function testUnrelatedWorksCanComplete(tw) {
	var f = fixture(tw);
	var a = f.work("continuation-independent-01");
	var b = f.work("continuation-independent-02");

	a.transitions = [a.transitions[0]];
	b.transitions = [b.transitions[1]];

	var aTitle = f.publish("independent-a", a);
	var bTitle = f.publish("independent-b", b);

	var report = f.runtime.recover();

	[aTitle, bTitle].forEach(function (title) {
		assert(report.entries.some(function (entry) {
			return entry.title === title && entry.status === "completed";
		}));
		assert(!f.wiki.tiddlerExists(title));
	});
}

function testUnknownWalPreventsWrites(tw) {
	var f = fixture(tw);
	var title = f.publish(
		"known",
		f.work("continuation-with-unknown-01")
	);

	var other = f.platform === "browser" ? "node" : "browser";

	f.wiki.addTiddler(new tw.Tiddler({
		title: "$:/clerus/wal/" + other + "/unknown",
		type: "application/json",
		"clerus-custody": "user",
		"clerus-wal-kind": "future-kind",
		text: JSON.stringify({
			version: 99,
			kind: "future-kind",
			platform: other
		})
	}));

	var report = f.runtime.recover();

	assert(report.entries.some(function (entry) {
		return entry.title === title && entry.status === "failed";
	}));

	assert(
		JSON.parse(f.wiki.getTiddlerText(f.first))
			.charter.status.phase === "initial"
	);
}

function testRetainedEmptyJournal(tw) {
	var now = 1000000;

	var f = fixture(tw, {
		delay: 150000,
		now: function () {
			return now;
		}
	});

	var title = f.publish(
		"retained-empty",
		f.work("continuation-retained-0001")
	);

	f.runtime.recover();

	var tiddler = f.wiki.getTiddler(title);
	var record = JSON.parse(tiddler.fields.text);

	assert(record.work === null);
	assert(Object.keys(record.events).length === 0);
	assert(record.retainUntil === 1150000);

	// Repeated servicing must not move the deadline.
	now = 1100000;
	f.runtime.recover();

	assert(
		JSON.parse(f.wiki.getTiddlerText(title)).retainUntil === 1150000
	);

	// User custody forbids timed deletion.
	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(title),
		{ "clerus-custody": "user" }
	));

	now = 1200000;
	f.runtime.recover();

	assert(f.wiki.tiddlerExists(title));

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(title),
		{ "clerus-custody": f.platform }
	));

	f.runtime.recover();

	assert(!f.wiki.tiddlerExists(title));
}

exports.run = function (tw) {
	var cases = [
		["runtime recovers a material continuation", testRuntimeRecovery],
		["user custody preserves barriers and retention", testUserCustodyPreservesPerspective],
		["partial materialization survives restart", testInterruptedRecovery],
		["conflicting journals have no automatic winner", testConflictingJournalsHaveNoWinner],
		["unrelated works can complete", testUnrelatedWorksCanComplete],
		["unknown WAL prevents writes", testUnknownWalPreventsWrites],
		["exhausted journal retention survives repeated servicing", testRetainedEmptyJournal]
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