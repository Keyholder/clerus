/*\
title: $:/plugins/clerus/tests/core/custody-binding.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var stores = require("$:/plugins/clerus/core/store.js");
var barriers = require(
	"$:/plugins/clerus/core/materialization-barrier.js"
);
var continuationSchema = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var destination = platform === "browser" ? "node" : "browser";

	var target = "$:/clerus/jobs/binding-target-unique";
	var journal = "$:/clerus/wal/" + platform + "/binding-unique";
	var workId = "binding-transfer-work-0001";
	var sequence = 0;
	var calls = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "binding-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: {}
			}
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		newId: function () {
			sequence++;
			return "binding-generated-" +
				String(sequence).padStart(12, "0");
		},
		resolveExecutor: function () {
			return function () {
				calls++;
			};
		}
	});

	var before = runtime.store.read(target).fields;
	var marker = {
		version: 1,
		journal: journal,
		work: workId,
		from: platform,
		to: destination
	};

	var after = Object.assign({}, before, {
		"clerus-custody": destination,
		"clerus-custody-transfer": JSON.stringify(marker)
	});

	var record = {
		version: 2,
		kind: "continuation",
		platform: platform,
		work: {
			version: 2,
			id: workId,
			checks: [],
			transitions: [
				stores.transition(target, before, after)
			],
			blocks: [],
			emits: []
		},
		events: {},
		evidence: {
			identities: {},
			receipts: {}
		},
		diagnostics: []
	};

	function publish(value) {
		wiki.addTiddler(new tw.Tiddler({
			title: journal,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-wal-kind": "continuation",
			text: JSON.stringify(value)
		}));
	}

	return {
		wiki: wiki,
		platform: platform,
		destination: destination,
		target: target,
		journal: journal,
		runtime: runtime,
		before: before,
		record: record,
		publish: publish,
		calls: function () {
			return calls;
		}
	};
}

function mutateMarker(record, change) {
	var effect = record.work.transitions[0];
	var marker = JSON.parse(
		effect.after["clerus-custody-transfer"]
	);

	change(marker);

	effect.after["clerus-custody-transfer"] =
		JSON.stringify(marker);
}

function assertRejected(tw, change) {
	var f = fixture(tw);
	var record = clone(f.record);

	change(record, f);
	f.publish(record);

	var originalBody = f.wiki.getTiddlerText(f.journal);

	assert(!barriers.collect({
		store: f.runtime.store
	}).inspect().complete);

	var report = f.runtime.recover();

	assert(report.entries.some(function (entry) {
		return (
			entry.title === f.journal &&
			entry.status === "failed"
		);
	}));

	assert(
		JSON.stringify(f.runtime.store.read(f.target).fields) ===
			JSON.stringify(f.before)
	);

	var journal = f.wiki.getTiddler(f.journal);

	assert(journal);
	assert(journal.fields["clerus-custody"] === "user");
	assert(journal.fields.text === originalBody);
	assert(f.calls() === 0);

	assert(!barriers.collect({
		store: f.runtime.store
	}).inspect().complete);
}

function testWrongJournal(tw) {
	assertRejected(tw, function (record, f) {
		mutateMarker(record, function (marker) {
			marker.journal =
				"$:/clerus/wal/" + f.platform + "/another-unique";
		});
	});
}

function testWrongWork(tw) {
	assertRejected(tw, function (record) {
		mutateMarker(record, function (marker) {
			marker.work = "another-transfer-work-0001";
		});
	});
}

function testWrongDirection(tw) {
	assertRejected(tw, function (record, f) {
		mutateMarker(record, function (marker) {
			marker.from = f.destination;
		});
	});
}

function testMissingMarker(tw) {
	assertRejected(tw, function (record) {
		delete record.work.transitions[0]
			.after["clerus-custody-transfer"];
	});
}

function testMarkerOnlyRewrite(tw) {
	assertRejected(tw, function (record, f) {
		var effect = record.work.transitions[0];

		effect.after["clerus-custody"] = f.platform;

		mutateMarker(record, function (marker) {
			marker.from = f.destination;
			marker.to = f.platform;
			marker.journal =
				"$:/clerus/wal/" + f.destination + "/other-source";
		});
	});
}

function testBirthCannotSmuggleTransferMarker(tw) {
	assertRejected(tw, function (record) {
		record.work.transitions[0].before = null;
	});
}

function testInvalidJournalCannotGrantSourceOwnership(tw) {
	var f = fixture(tw);
	var record = clone(f.record);

	/*
		Model the already materialized destination, then damage
		the alleged authoritative journal.
	*/
	f.wiki.addTiddler(new tw.Tiddler(
		record.work.transitions[0].after
	));

	record.futureObligation = {};
	f.publish(record);

	assert(!f.runtime.custody.owns(
		f.runtime.store.read(f.target).fields
	));
	assert(f.calls() === 0);
}

function testValidBinding(tw) {
	var f = fixture(tw);

	var record = continuationSchema.validate(
		f.record,
		f.platform,
		f.journal
	);

	assert(record.work.id === f.record.work.id);

	f.publish(record);

	var report = f.runtime.recover();

	assert(report.entries.some(function (entry) {
		return (
			entry.title === f.journal &&
			entry.status === "completed"
		);
	}));

	assert(
		f.runtime.store.read(f.target)
			.fields["clerus-custody"] === f.destination
	);
	assert(!f.wiki.tiddlerExists(f.journal));
	assert(f.calls() === 0);
}

exports.run = function (tw) {
	var cases = [
		["transfer must name its actual journal", testWrongJournal],
		["transfer must name its actual work", testWrongWork],
		["transfer direction must match accepted authority", testWrongDirection],
		["custody change requires a marker", testMissingMarker],
		["ordinary work cannot rewrite the marker alone", testMarkerOnlyRewrite],
		["birth cannot smuggle a transfer marker", testBirthCannotSmuggleTransferMarker],
		["invalid journal cannot grant source ownership", testInvalidJournalCannotGrantSourceOwnership],
		["valid binding materializes without executor invocation", testValidBinding]
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