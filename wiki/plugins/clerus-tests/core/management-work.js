/*\
title: $:/plugins/clerus/tests/core/management-work.js
type: application/javascript
module-type: library
\*/

"use strict";

var publishers = require("$:/plugins/clerus/core/management-work.js");
var stores = require("$:/plugins/clerus/core/store.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var journal = "$:/clerus/wal/" + platform + "/publisher-test";
	var target = "Management Work Publisher Target";

	var publisher = publishers.create({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		now: function () {
			return 1000000;
		},
		prototypeWalReceipts: true
	});

	var work = {
		version: 2,
		id: "management-publisher-work-0001",
		checks: [],
		transitions: [
			stores.transition(target, null, {
				title: target,
				type: "text/plain",
				"clerus-custody": platform,
				text: "prepared"
			})
		],
		blocks: [],
		emits: []
	};

	return {
		wiki: wiki,
		platform: platform,
		journal: journal,
		target: target,
		publisher: publisher,
		work: work
	};
}

function testPublishesWithoutMaterialization(tw) {
	var f = fixture(tw);

	f.publisher.publish(f.work, f.journal);

	assert(!f.wiki.tiddlerExists(f.target));

	var tiddler = f.wiki.getTiddler(f.journal);
	var record = JSON.parse(tiddler.fields.text);

	assert(tiddler.fields["clerus-custody"] === "user");
	assert(record.retainUntil === 1150000);
	assert(record.work.id === f.work.id);
	assert(record.work.transitions.length === 1);
}

function testPreservesExplicitDeadline(tw) {
	var f = fixture(tw);

	f.publisher.publishRecord({
		version: 2,
		kind: "continuation",
		platform: f.platform,
		retainUntil: 1234567,
		work: f.work,
		events: {},
		evidence: {
			identities: {},
			receipts: {}
		},
		diagnostics: []
	}, f.journal);

	assert(
		JSON.parse(f.wiki.getTiddlerText(f.journal))
			.retainUntil === 1234567
	);
	assert(!f.wiki.tiddlerExists(f.target));
}

function testRejectedWorkPublishesNothing(tw) {
	var f = fixture(tw);

	f.wiki.addTiddler(new tw.Tiddler({
		title: f.target,
		"clerus-custody": f.platform,
		text: "occupied"
	}));

	var before = f.wiki.getTiddlerText(f.target);
	var caught = false;

	try {
		f.publisher.publish(f.work, f.journal);
	} catch (error) {
		caught = true;
	}

	assert(caught);
	assert(!f.wiki.tiddlerExists(f.journal));
	assert(f.wiki.getTiddlerText(f.target) === before);
}

exports.run = function (tw) {
	var cases = [
		["management work: publication does not materialize targets", testPublishesWithoutMaterialization],
		["management work: explicit deadline is preserved", testPreservesExplicitDeadline],
		["management work: rejected work publishes no journal", testRejectedWorkPublishesNothing]
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