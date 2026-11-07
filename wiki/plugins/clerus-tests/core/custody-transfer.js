/*\
title: $:/plugins/clerus/tests/core/custody-transfer.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var stores = require("$:/plugins/clerus/core/store.js");
var evidence = require("$:/plugins/clerus/core/custody-evidence.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var sourcePlatform = tw.browser ? "browser" : "node";
	var destinationPlatform =
		sourcePlatform === "browser" ? "node" : "browser";

	var sourceWiki = new tw.Wiki();
	var destinationWiki = new tw.Wiki();

	var target = "$:/clerus/jobs/transfer-job-unique";
	var tail = "$:/clerus/jobs/transfer-tail";
	var journal =
		"$:/clerus/wal/" + sourcePlatform + "/transfer-test";
	var workId = "transfer-test-work-000001";
	var sequence = 0;
	var calls = 0;

	function runtime(wiki, platform) {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: function () {
				sequence++;
				return "transfer-generated-" +
					String(sequence).padStart(12, "0");
			},
			resolveExecutor: function () {
				return function () {
					calls++;
				};
			}
		});
	}

	[target, tail].forEach(function (title) {
		sourceWiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": sourcePlatform,
			"clerus-executor": "transfer-test",
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: {}
				}
			})
		}));
	});

	var source = runtime(sourceWiki, sourcePlatform);
	var destination = runtime(
		destinationWiki,
		destinationPlatform
	);

	var before = source.store.read(target).fields;
	var after = Object.assign({}, before, {
		"clerus-custody": destinationPlatform,
		"clerus-custody-transfer": JSON.stringify({
			version: 1,
			journal: journal,
			work: workId,
			from: sourcePlatform,
			to: destinationPlatform
		})
	});

	var record = {
		version: 2,
		kind: "continuation",
		platform: sourcePlatform,
		work: {
			version: 2,
			id: workId,
			checks: [],
			transitions: [
				stores.transition(target, before, after)
			],
			blocks: [],
			emits: [{
				id: "transfer-tail-event-00001",
				event: {
					kind: "delivery",
					recipient: {
						title: tail,
						executor: "transfer-test"
					},
					type: "order",
					registry: {}
				}
			}]
		},
		events: {},
		evidence: {
			identities: {},
			receipts: {}
		},
		diagnostics: []
	};

	sourceWiki.addTiddler(new tw.Tiddler({
		title: journal,
		type: "application/json",
		"clerus-custody": sourcePlatform,
		"clerus-wal-kind": "continuation",
		text: JSON.stringify(record)
	}));

	function copy(title) {
		destinationWiki.addTiddler(new tw.Tiddler(
			sourceWiki.getTiddler(title)
		));
	}

	return {
		sourceWiki: sourceWiki,
		destinationWiki: destinationWiki,
		sourcePlatform: sourcePlatform,
		destinationPlatform: destinationPlatform,
		source: source,
		destination: destination,
		restartSource: function () {
			return runtime(sourceWiki, sourcePlatform);
		},
		restartDestination: function () {
			return runtime(destinationWiki, destinationPlatform);
		},
		target: target,
		journal: journal,
		copy: copy,
		calls: function () {
			return calls;
		}
	};
}

function testReleaseAndEntryAreSeparate(tw) {
	var f = fixture(tw);
	var originalApply = f.source.store.apply;
	var injected = false;

	f.source.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.target && !injected) {
			injected = true;
			throw new Error("After transfer snapshot write");
		}

		return result;
	};

	try {
		f.source.recover();
	} finally {
		f.source.store.apply = originalApply;
	}

	assert(injected);

	var sourceFields = f.source.store.read(f.target).fields;

	assert(
		sourceFields["clerus-custody"] ===
			f.destinationPlatform
	);

	assert(f.source.custody.owns(sourceFields));

	f.copy(f.target);
	f.copy(f.journal);

	assert(!f.destination.custody.owns(
		f.destination.store.read(f.target).fields
	));

	var restartedSource = f.restartSource();

	assert(restartedSource.custody.owns(
		restartedSource.store.read(f.target).fields
	));

	var blocked = restartedSource.dispatch(
		f.target,
		{ type: "test" }
	);

	assert(blocked.status === "blocked");
	assert(f.calls() === 0);

	f.sourceWiki.addTiddler(new tw.Tiddler(
		f.sourceWiki.getTiddler(f.journal),
		{ "clerus-custody": f.sourcePlatform }
	));

	restartedSource.recover();

	var record = JSON.parse(
		f.sourceWiki.getTiddlerText(f.journal)
	);

	assert(record.work === null);
	assert(Object.keys(record.events).length === 1);

	assert(!restartedSource.custody.owns(
		restartedSource.store.read(f.target).fields
	));

	f.copy(f.journal);

	assert(!f.destination.custody.owns(
		f.destination.store.read(f.target).fields
	));

	restartedSource.drainFlows();

	assert(!f.sourceWiki.tiddlerExists(f.journal));
	assert(f.calls() === 1);

	/*
		The destination still has its old journal copy.
		Source deletion alone grants it nothing.
	*/
	assert(!f.destination.custody.owns(
		f.destination.store.read(f.target).fields
	));

	f.destinationWiki.deleteTiddler(f.journal);

	/*
		Even local absence is not the protocol evidence.
	*/
	assert(!f.destination.custody.owns(
		f.destination.store.read(f.target).fields
	));

	evidence.create({
		store: f.destination.store,
		platform: f.destinationPlatform
	}).recordWalDeletion(f.journal);

	var restartedDestination = f.restartDestination();

	assert(restartedDestination.custody.owns(
		restartedDestination.store.read(f.target).fields
	));

	assert(!restartedSource.custody.owns(
		restartedSource.store.read(f.target).fields
	));
}

function testCopiedMarkerDoesNotExtendSourceAuthority(tw) {
	var f = fixture(tw);
	var originalApply = f.source.store.apply;
	var injected = false;

	f.source.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.target && !injected) {
			injected = true;
			throw new Error("Keep active transfer work");
		}

		return result;
	};

	try {
		f.source.recover();
	} finally {
		f.source.store.apply = originalApply;
	}

	assert(injected);

	var current = f.sourceWiki.getTiddler(f.target);

	f.sourceWiki.addTiddler(new tw.Tiddler(current, {
		caption: "State no longer covered by the transition"
	}));

	assert(!f.source.custody.owns(
		f.source.store.read(f.target).fields
	));
}

exports.run = function (tw) {
	var cases = [
		["source release precedes destination entry", testReleaseAndEntryAreSeparate],
		["marker does not authorize an arbitrary source snapshot", testCopiedMarkerDoesNotExtendSourceAuthority]
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