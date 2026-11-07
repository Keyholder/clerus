/*\
title: $:/plugins/clerus/tests/core/custody-evidence.js
type: application/javascript
module-type: library
\*/

"use strict";

var stores = require("$:/plugins/clerus/core/store.js");
var custodySchema = require(
	"$:/plugins/clerus/core/custody-schema.js"
);
var evidence = require(
	"$:/plugins/clerus/core/custody-evidence.js"
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
	var source = platform === "browser" ? "node" : "browser";
	var journal = "$:/clerus/wal/" + source + "/transfer-example";

	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	function service() {
		return evidence.create({
			store: store,
			platform: platform
		});
	}

	return {
		wiki: wiki,
		store: store,
		platform: platform,
		source: source,
		journal: journal,
		service: service,

		marker: function () {
			return {
				version: 1,
				journal: journal,
				work: "custody-transfer-work-0001",
				from: source,
				to: platform
			};
		},

		jobFields: function () {
			return {
				title: "$:/clerus/jobs/transferred-unique",
				type: "application/json",
				"clerus-custody": platform,
				"clerus-executor": "example",
				"clerus-custody-transfer": JSON.stringify(
					this.marker()
				),
				text: JSON.stringify({
					charter: {
						form: "charter",
						status: {}
					}
				})
			};
		}
	};
}

function testAbsenceIsNotEvidence(tw) {
	var f = fixture(tw);

	assert(f.store.read(f.journal).kind === "absent");
	assert(f.service().lookup(f.journal).kind === "absent");
}

function testEvidenceBeforeJob(tw) {
	var f = fixture(tw);
	var first = f.service().recordWalDeletion(f.journal);

	assert(first.status === "recorded");
	assert(
		f.store.read("$:/clerus/jobs/transferred-unique").kind ===
			"absent"
	);

	var restarted = f.service();

	assert(restarted.lookup(f.journal).kind === "recorded");

	var fields = f.jobFields();
	f.wiki.addTiddler(new tw.Tiddler(fields));

	var marker = custodySchema.readTransfer(fields);

	assert(marker.journal === f.journal);
	assert(marker.to === f.platform);
	assert(restarted.lookup(marker.journal).kind === "recorded");
}

function testJobBeforeEvidence(tw) {
	var f = fixture(tw);
	var fields = f.jobFields();

	f.wiki.addTiddler(new tw.Tiddler(fields));

	var marker = custodySchema.readTransfer(fields);

	assert(f.service().lookup(marker.journal).kind === "absent");

	f.service().recordWalDeletion(marker.journal);

	assert(f.service().lookup(marker.journal).kind === "recorded");
}

function testRepeatDoesNotReclaimUserCustody(tw) {
	var f = fixture(tw);
	var first = f.service().recordWalDeletion(f.journal);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(first.title),
		{
			"clerus-custody": "user",
			caption: "User annotation"
		}
	));

	var before = f.store.read(first.title).fields;
	var repeated = f.service().recordWalDeletion(f.journal);
	var after = f.store.read(first.title).fields;

	assert(repeated.status === "already-recorded");
	assert(JSON.stringify(before) === JSON.stringify(after));
}

function testCorruptEvidenceIsNotOverwritten(tw) {
	var f = fixture(tw);
	var title = custodySchema.deletionTitle(
		f.platform,
		f.journal
	);

	f.wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": "user",
		"clerus-custody-kind": "wal-deletion",
		text: "{broken"
	}));

	throws(function () {
		f.service().recordWalDeletion(f.journal);
	}, "Invalid WAL deletion evidence JSON");

	assert(f.wiki.getTiddlerText(title) === "{broken");
}

function testUncertainWriteCanBeReadAfterRestart(tw) {
	var f = fixture(tw);
	var originalApply = f.store.apply;
	var injected = false;

	f.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (!injected) {
			injected = true;
			throw new Error("Interrupted after evidence write");
		}

		return result;
	};

	var error;

	try {
		error = throws(function () {
			f.service().recordWalDeletion(f.journal);
		}, "Interrupted after evidence write");
	} finally {
		f.store.apply = originalApply;
	}

	assert(error.recordingUncertain);
	assert(error.evidenceTitle);

	var restarted = f.service();

	assert(restarted.lookup(f.journal).kind === "recorded");
	assert(
		restarted.recordWalDeletion(f.journal).status ===
			"already-recorded"
	);
}

function testMarkerBinding(tw) {
	var f = fixture(tw);
	var fields = f.jobFields();

	assert(custodySchema.readTransfer(fields).from === f.source);

	fields["clerus-custody"] = f.source;

	throws(function () {
		custodySchema.readTransfer(fields);
	}, "destination does not match");

	fields = f.jobFields();
	fields.title = "$:/temp/clerus/jobs/" +
		f.platform + "/not-transferable";

	throws(function () {
		custodySchema.readTransfer(fields);
	}, "requires a persistent job");

	fields = f.jobFields();
	fields["clerus-custody-transfer"] = "{broken";

	throws(function () {
		custodySchema.readTransfer(fields);
	}, "Invalid custody transfer marker JSON");
}

exports.run = function (tw) {
	var cases = [
		["WAL absence is not deletion evidence", testAbsenceIsNotEvidence],
		["deletion evidence may precede the job", testEvidenceBeforeJob],
		["job may precede deletion evidence", testJobBeforeEvidence],
		["repeated notification preserves user custody", testRepeatDoesNotReclaimUserCustody],
		["corrupt evidence is not overwritten", testCorruptEvidenceIsNotOverwritten],
		["uncertain registration survives restart", testUncertainWriteCanBeReadAfterRestart],
		["transfer marker is bound to destination and job space", testMarkerBinding]
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