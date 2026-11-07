/*\
title: $:/plugins/clerus/tests/core/custody-roundtrip.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var stores = require("$:/plugins/clerus/core/store.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var firstPlatform = tw.browser ? "browser" : "node";
	var secondPlatform =
		firstPlatform === "browser" ? "node" : "browser";

	var target = "$:/clerus/jobs/custody-roundtrip-unique";
	var sequence = 0;
	var calls = 0;

	function side(platform) {
		var wiki = new tw.Wiki();

		var runtime = new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: function () {
				sequence++;
				return "roundtrip-generated-" +
					String(sequence).padStart(12, "0");
			},
			resolveExecutor: function () {
				return function () {
					calls++;
				};
			}
		});

		return {
			platform: platform,
			wiki: wiki,
			runtime: runtime
		};
	}

	var first = side(firstPlatform);
	var second = side(secondPlatform);

	first.wiki.addTiddler(new tw.Tiddler({
		title: target,
		type: "application/json",
		"clerus-custody": firstPlatform,
		"clerus-executor": "roundtrip-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: {}
			}
		})
	}));

	function move(from, to, suffix) {
		var journal =
			"$:/clerus/wal/" + from.platform +
			"/roundtrip-" + suffix;

		var workId = "roundtrip-work-" + suffix +
			"-00000001";

		var before = from.runtime.store.read(target).fields;

		assert(from.runtime.custody.owns(before));

		var after = Object.assign({}, before, {
			"clerus-custody": to.platform,
			"clerus-custody-transfer": JSON.stringify({
				version: 1,
				journal: journal,
				work: workId,
				from: from.platform,
				to: to.platform
			})
		});

		from.wiki.addTiddler(new tw.Tiddler({
			title: journal,
			type: "application/json",
			"clerus-custody": from.platform,
			"clerus-wal-kind": "continuation",
			text: JSON.stringify({
				version: 2,
				kind: "continuation",
				platform: from.platform,
				work: {
					version: 2,
					id: workId,
					checks: [],
					transitions: [
						stores.transition(
							target,
							before,
							after
						)
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
			})
		}));

		var recovery = from.runtime.recover();

		assert(recovery.entries.some(function (entry) {
			return (
				entry.title === journal &&
				entry.status === "completed"
			);
		}));

		assert(!from.wiki.tiddlerExists(journal));
		assert(!from.runtime.custody.owns(
			from.runtime.store.read(target).fields
		));

		to.wiki.addTiddler(new tw.Tiddler(
			from.wiki.getTiddler(target)
		));

		assert(!to.runtime.custody.owns(
			to.runtime.store.read(target).fields
		));

		/*
			The environment supplies the received deletion.
			The journal was never materialized on this side;
			local absence alone granted nothing.
		*/
		to.runtime.recordWalDeletion(journal);

		assert(to.runtime.custody.owns(
			to.runtime.store.read(target).fields
		));

		return journal;
	}

	return {
		first: first,
		second: second,
		target: target,
		move: move,
		calls: function () {
			return calls;
		}
	};
}

function testRoundTrip(tw) {
	var f = fixture(tw);

	var outward = f.move(
		f.first,
		f.second,
		"outward"
	);

	var returning = f.move(
		f.second,
		f.first,
		"returning"
	);

	assert(outward !== returning);
	assert(f.calls() === 0);

	assert(f.first.runtime.custody.owns(
		f.first.runtime.store.read(f.target).fields
	));

	assert(!f.second.runtime.custody.owns(
		f.second.runtime.store.read(f.target).fields
	));
}

exports.run = function (tw) {
	var results = [];

	try {
		testRoundTrip(tw);

		results.push({
			name: "repeated relocation uses fresh journal identities",
			passed: true,
			error: null
		});
	} catch (error) {
		results.push({
			name: "repeated relocation uses fresh journal identities",
			passed: false,
			error: String(error.stack || error)
		});
	}

	return {
		passed: results.every(function (result) {
			return result.passed;
		}),
		results: results
	};
};