/*\
title: $:/plugins/clerus/tests/core/custody-entry.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var localCustody = require("$:/plugins/clerus/core/local-custody.js");
var evidence = require("$:/plugins/clerus/core/custody-evidence.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = platform === "browser" ? "node" : "browser";
	var journal = "$:/clerus/wal/" + source + "/entry-example";
	var target = "$:/clerus/jobs/custody-entry-target";
	var sequence = 0;
	var calls = 0;

	function fields() {
		return {
			title: target,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "entry-test",
			"clerus-custody-transfer": JSON.stringify({
				version: 1,
				journal: journal,
				work: "entry-transfer-work-00001",
				from: source,
				to: platform
			}),
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: { phase: "initial" }
				}
			})
		};
	}

	function createRuntime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: function () {
				sequence++;
				return "entry-generated-" +
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
	}

	var runtime = createRuntime();

	function recordDeletion() {
		return evidence.create({
			store: runtime.store,
			platform: platform
		}).recordWalDeletion(journal);
	}

	return {
		wiki: wiki,
		platform: platform,
		target: target,
		journal: journal,
		runtime: runtime,
		restart: createRuntime,
		fields: fields,
		recordDeletion: recordDeletion,
		calls: function () {
			return calls;
		},
		writeJob: function () {
			wiki.addTiddler(new tw.Tiddler(fields()));
		}
	};
}

function testAssignmentDoesNotGrantEntry(tw) {
	var f = fixture(tw);
	f.writeJob();

	var fields = f.runtime.store.read(f.target).fields;

	assert(!f.runtime.custody.owns(fields));

	var result = f.runtime.dispatch(
		f.target,
		{ type: "test" }
	);

	assert(result.status === "failed");
	assert(result.phase === "reaction");
	assert(f.calls() === 1);

	/*
		The restricted reaction failed, but this runtime cannot
		suspend a job it does not yet own.
	*/
	assert(!result.lifecycle.suspended);
	assert(result.lifecycle.reason === "not-locally-owned");

	var current = f.wiki.getTiddler(f.target);

	assert(
		JSON.parse(current.fields.text)
			.charter.status.phase === "initial"
	);
	assert(current.fields["clerus-custody"] === f.platform);
	assert(current.fields["clerus-suspended"] === undefined);
}

function testEvidenceEnablesEntryAfterRestart(tw) {
	var f = fixture(tw);
	f.writeJob();

	assert(!f.runtime.custody.owns(
		f.runtime.store.read(f.target).fields
	));

	f.recordDeletion();

	var restarted = f.restart();

	assert(restarted.custody.owns(
		restarted.store.read(f.target).fields
	));

	var result = restarted.dispatch(
		f.target,
		{ type: "test" }
	);

	assert(result.status === "completed");
	assert(f.calls() === 1);

	assert(
		JSON.parse(f.wiki.getTiddlerText(f.target))
			.charter.status.phase === "written"
	);
}

function testEvidenceMayArriveFirst(tw) {
	var f = fixture(tw);

	f.recordDeletion();
	f.writeJob();

	var restarted = f.restart();

	assert(restarted.custody.owns(
		restarted.store.read(f.target).fields
	));
}

function testCollectionWaitsForEntry(tw) {
	var f = fixture(tw);
	f.writeJob();

	var first = f.runtime.collect();

	assert(first.removed.indexOf(f.target) === -1);
	assert(first.skipped.some(function (entry) {
		return (
			entry.title === f.target &&
			entry.reason === "not-locally-owned"
		);
	}));

	assert(f.wiki.tiddlerExists(f.target));

	f.recordDeletion();

	var second = f.runtime.collect();

	assert(second.removed.indexOf(f.target) !== -1);
	assert(!f.wiki.tiddlerExists(f.target));
}

function testMalformedMarkerDeniesEntry(tw) {
	var f = fixture(tw);
	var fields = f.fields();

	fields["clerus-custody-transfer"] = "{broken";

	f.wiki.addTiddler(new tw.Tiddler(fields));
	f.recordDeletion();

	assert(!f.runtime.custody.owns(
		f.runtime.store.read(f.target).fields
	));
}

function testReaderFailurePropagates(tw) {
	var f = fixture(tw);
	var sentinel = new Error("Evidence storage unavailable");

	var custody = localCustody.create({
		platform: f.platform,
		store: {
			read: function () {
				throw sentinel;
			}
		}
	});

	var caught;

	try {
		custody.owns(f.fields());
	} catch (error) {
		caught = error;
	}

	assert(caught === sentinel);
}

function testNoReaderCannotGrantTransferEntry(tw) {
	var f = fixture(tw);

	var custody = localCustody.create({
		platform: f.platform
	});

	assert(!custody.owns(f.fields()));
}

exports.run = function (tw) {
	var cases = [
		["new assignment alone does not grant entry", testAssignmentDoesNotGrantEntry],
		["durable evidence enables entry after restart", testEvidenceEnablesEntryAfterRestart],
		["evidence may arrive before the job", testEvidenceMayArriveFirst],
		["collection waits for local entry", testCollectionWaitsForEntry],
		["malformed marker denies entry", testMalformedMarkerDeniesEntry],
		["evidence reader failures propagate", testReaderFailurePropagates],
		["missing reader cannot grant transfer entry", testNoReaderCannotGrantTransferEntry]
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