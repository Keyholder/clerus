/*\
title: $:/plugins/clerus/tests/core/prototype-wal-receipts.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var receipts = require(
	"$:/plugins/clerus/core/prototype-wal-receipts.js"
);
var events = require("$:/plugins/clerus/core/event-schema.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = platform === "browser" ? "node" : "browser";
	var journal = "$:/clerus/wal/" + source + "/prototype-receipt-test";
	var target = "$:/clerus/jobs/prototype-receipt-target";
	var deadline = 1000000;
	var time = deadline - 1;
	var sequence = 0;
	var calls = 0;

	function assembly() {
		var runtime = new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,

			newId: function () {
				sequence++;

				return "prototype-receipt-" +
					String(sequence).padStart(12, "0");
			},

			resolveExecutor: function () {
				return function (event, operational) {
					calls++;

					operational.get("charter").setStatus({
						phase: "written"
					});
				};
			}
		});

		var heuristic = receipts.create({
			wiki: wiki,
			platform: platform,
			now: function () {
				return time;
			},
			recordWalDeletion: runtime.recordWalDeletion.bind(runtime)
		});

		return {
			runtime: runtime,
			heuristic: heuristic
		};
	}

	function writeJob(withDeadline) {
		var marker = {
			version: 1,
			journal: journal,
			work: "prototype-transfer-work-0001",
			from: source,
			to: platform
		};

		if (withDeadline !== false) {
			marker.retainUntil = deadline;
		}

		wiki.addTiddler(new tw.Tiddler({
			title: target,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "prototype-receipt-test",
			"clerus-custody-transfer": JSON.stringify(marker),
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: { phase: "initial" }
				}
			})
		}));
	}

	function record() {
		return {
			version: 2,
			kind: "continuation",
			platform: source,
			retainUntil: deadline,
			work: null,
			events: {},
			evidence: {
				identities: {},
				receipts: {}
			},
			diagnostics: []
		};
	}

	function publish(value) {
		wiki.addTiddler(new tw.Tiddler({
			title: journal,
			type: "application/json",
			"clerus-custody": source,
			"clerus-wal-kind": "continuation",
			text: JSON.stringify(value)
		}));
	}

	function owns(side) {
		return side.runtime.custody.owns(
			side.runtime.store.read(target).fields
		);
	}

	return {
		wiki: wiki,
		platform: platform,
		source: source,
		journal: journal,
		target: target,
		deadline: deadline,
		assembly: assembly,
		writeJob: writeJob,
		record: record,
		publish: publish,
		owns: owns,

		setTime: function (value) {
			time = value;
		},

		calls: function () {
			return calls;
		}
	};
}

function testAbsentWalAfterRestart(tw) {
	var f = fixture(tw);
	f.writeJob();

	var first = f.assembly();

	assert(!f.owns(first));
	assert(first.heuristic.scan().received.length === 0);

	/*
	Discard the entire receiving assembly. The new heuristic
	has never observed this journal.
	*/
	var restarted = f.assembly();

	f.setTime(f.deadline);

	var result = restarted.heuristic.scan();

	assert(result.errors.length === 0);
	assert(result.received.length === 1);
	assert(
		result.received[0].basis ===
			"prototype-expired-lifetime-and-absence"
	);
	assert(f.owns(restarted));
	assert(f.calls() === 0);

	// Once recorded, entry survives another runtime restart.
	var again = f.assembly();

	assert(f.owns(again));
	assert(again.heuristic.scan().received.length === 0);

	var reaction = again.runtime.dispatch(
		f.target,
		{ type: "test" }
	);

	assert(reaction.status === "completed");
	assert(f.calls() === 1);
	assert(
		JSON.parse(f.wiki.getTiddlerText(f.target))
			.charter.status.phase === "written"
	);
}

function testExistingPendingWalBlocksEntry(tw) {
	var f = fixture(tw);
	f.writeJob();

	var record = f.record();
	var id = "prototype-pending-event-0001";

	var event = {
		kind: "activation",
		recipient: {
			title: "$:/clerus/jobs/prototype-source-pending",
			executor: "prototype-source-test"
		}
	};

	record.events[id] = {
		mode: "ready",
		event: event
	};
	record.evidence.identities[id] = events.fingerprint(event);

	f.publish(record);
	f.setTime(f.deadline + 1000000);

	var side = f.assembly();
	var result = side.heuristic.scan();

	assert(result.errors.length === 0);
	assert(result.received.length === 0);
	assert(!f.owns(side));

	// Pausing the event does not make the journal exhausted.
	record.events[id].mode = "paused";
	f.publish(record);

	assert(side.heuristic.scan().received.length === 0);
	assert(!f.owns(side));
}

function testMalformedWalIsNotAbsence(tw) {
	var f = fixture(tw);
	f.writeJob();
	f.setTime(f.deadline + 1);

	f.wiki.addTiddler(new tw.Tiddler({
		title: f.journal,
		type: "application/json",
		"clerus-custody": f.source,
		"clerus-wal-kind": "continuation",
		text: "{broken"
	}));

	var side = f.assembly();

	assert(side.heuristic.scan().received.length === 0);
	assert(!f.owns(side));
}

function testEmptyWalEnablesEarlyEntry(tw) {
	var f = fixture(tw);
	f.writeJob();
	f.publish(f.record());

	var side = f.assembly();
	var result = side.heuristic.scan();

	assert(result.received.length === 1);
	assert(result.received[0].basis === "prototype-empty-wal");
	assert(f.owns(side));

	// Evidence registration itself must not invoke an executor.
	assert(f.calls() === 0);
}

function testDiagnosticsAreNotEmptySuccess(tw) {
	var f = fixture(tw);
	f.writeJob();

	var record = f.record();

	record.diagnostics.push({
		phase: "reaction",
		error: { message: "Unresolved diagnostic fixture" }
	});

	f.publish(record);
	f.setTime(f.deadline + 1);

	var side = f.assembly();

	assert(side.heuristic.scan().received.length === 0);
	assert(!f.owns(side));
}

function testLegacyMarkerDoesNotInferCompletion(tw) {
	var f = fixture(tw);
	f.writeJob(false);
	f.setTime(f.deadline + 1000000);

	var side = f.assembly();

	assert(side.heuristic.scan().received.length === 0);
	assert(!f.owns(side));
}

function testEvidenceMayPrecedeJob(tw) {
	var f = fixture(tw);
	f.publish(f.record());

	var side = f.assembly();

	assert(side.heuristic.scan().received.length === 1);
	assert(f.calls() === 0);

	f.writeJob();

	assert(f.owns(side));
}

exports.run = function (tw) {
	var cases = [
		["prototype receipts: absent WAL permits entry after restart and deadline", testAbsentWalAfterRestart],
		["prototype receipts: existing ready or paused event blocks entry", testExistingPendingWalBlocksEntry],
		["prototype receipts: malformed WAL is not absence", testMalformedWalIsNotAbsence],
		["prototype receipts: empty WAL permits entry before deadline", testEmptyWalEnablesEarlyEntry],
		["prototype receipts: diagnostics do not constitute empty success", testDiagnosticsAreNotEmptySuccess],
		["prototype receipts: legacy marker cannot infer completion from absence", testLegacyMarkerDoesNotInferCompletion],
		["prototype receipts: empty WAL evidence may precede the job", testEvidenceMayPrecedeJob]
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