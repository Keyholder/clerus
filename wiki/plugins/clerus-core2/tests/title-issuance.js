/*\
title: $:/plugins/clerus/core2/tests/title-issuance.js
type: application/javascript
module-type: library
\*/

"use strict";

var issuers = require(
	"$:/plugins/clerus/core2/title-issuer.js"
);
var reactions = require(
	"$:/plugins/clerus/core2/reaction.js"
);
var Store = require("$:/plugins/clerus/core2/store.js").Store;

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
	var owner =
		"$:/temp/clerus/jobs/" + platform + "/title-founder";

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "title-founder",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: {}
			}
		})
	}));

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var sequence = 0;

	function newId() {
		sequence++;

		return "test-identity-" +
			String(sequence).padStart(8, "0");
	}

	return {
		wiki: wiki,
		store: store,
		owner: owner,
		newId: newId,

		execute: function (handler) {
			return reactions.execute({
				store: store,
				title: owner,
				platform: platform,
				event: { type: "test" },
				newId: newId,

				readJobs: function () {
					var current = wiki.getTiddler(owner);

					return [{
						title: owner,
						custody: current.fields["clerus-custody"],
						registry: JSON.parse(current.fields.text)
					}];
				},

				handler: handler
			});
		}
	};
}

function testExplicitOperationalIssuance(tw) {
	var f = fixture(tw);
	var issued;

	f.execute(function (event, operational) {
		var form = operational.get("charter").createTitle(
			"worker",
			operational,
			"subordinate"
		);

		assert(form === operational.get("subordinate"));
		assert(!form.inspect().exists);

		issued = JSON.parse(
			f.wiki.getTiddler(f.owner).fields.text
		).subordinate;
	});

	assert(issued.indexOf(f.owner + "/worker-") === 0);
	assert(!f.wiki.getTiddler(issued));
}

function testSameSegmentDoesNotReuseAddress(tw) {
	var f = fixture(tw);
	var first;
	var second;

	f.execute(function (event, operational) {
		operational.get("charter").createTitle(
			"worker",
			operational,
			"first"
		);

		first = JSON.parse(
			f.wiki.getTiddler(f.owner).fields.text
		).first;

		operational.destroy("first");
	});

	f.execute(function (event, operational) {
		operational.get("charter").createTitle(
			"worker",
			operational,
			"second"
		);

		second = JSON.parse(
			f.wiki.getTiddler(f.owner).fields.text
		).second;
	});

	assert(first !== second);
}

function testOutgoingDestinationIsRejected(tw) {
	var f = fixture(tw);

	f.execute(function (event, operational) {
		var outgoing = operational.outgoing();

		throws(function () {
			operational.get("charter").createTitle(
				"worker",
				outgoing,
				"subordinate"
			);
		}, "issued operationally");

		assert(outgoing.keys().length === 0);
		assert(operational.keys().join(",") === "charter");
	});
}

function testRepeatingSourceIsRejected(tw) {
	var f = fixture(tw);

	var issuer = issuers.create({
		title: f.owner,
		store: f.store,
		newId: function () {
			return "repeated-identity-0001";
		}
	});

	var first = issuer.issue("worker");

	assert(!f.wiki.getTiddler(first));

	throws(function () {
		issuer.issue("worker");
	}, "repeated an identity");
}

function testOccupiedTitleIsRejected(tw) {
	var f = fixture(tw);
	var id = "occupied-identity-0001";
	var title = f.owner + "/worker-" + id;

	f.wiki.addTiddler(new tw.Tiddler({
		title: title,
		text: "existing"
	}));

	var issuer = issuers.create({
		title: f.owner,
		store: f.store,
		newId: function () {
			return id;
		}
	});

	throws(function () {
		issuer.issue("worker");
	}, "already occupied");

	assert(f.wiki.getTiddlerText(title) === "existing");
}

exports.run = function (tw) {
	var cases = [
		["title issuance: explicit operational document without birth", testExplicitOperationalIssuance],
		["title issuance: repeated segment produces a fresh address", testSameSegmentDoesNotReuseAddress],
		["title issuance: outgoing destination is rejected", testOutgoingDestinationIsRejected],
		["title issuance: repeated identifier is rejected", testRepeatingSourceIsRejected],
		["title issuance: occupied address is not overwritten", testOccupiedTitleIsRejected]
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