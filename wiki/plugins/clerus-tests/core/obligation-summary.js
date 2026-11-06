/*\
title: $:/plugins/clerus/tests/core/obligation-summary.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var events = require("$:/plugins/clerus/core/event-schema.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var sequence = 0;

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		newId: function () {
			sequence++;
			return "summary-generated-" +
				String(sequence).padStart(12, "0");
		},
		resolveExecutor: function () {
			return undefined;
		}
	});

	var delivery = {
		kind: "delivery",
		recipient: {
			title: "$:/clerus/jobs/summary-unavailable",
			executor: "unavailable"
		},
		type: "order",
		registry: {}
	};

	var activation = {
		kind: "activation",
		recipient: {
			title: "$:/clerus/jobs/summary-unavailable",
			executor: "unavailable"
		}
	};

	function publish() {
		var title =
			"$:/clerus/wal/" + platform + "/summary-events";
		var deliveryId = "summary-delivery-identity-01";
		var activationId = "summary-activation-identity-01";

		var record = {
			version: 2,
			kind: "continuation",
			platform: platform,
			work: null,
			events: {},
			evidence: {
				identities: {},
				receipts: {}
			},
			diagnostics: []
		};

		record.events[deliveryId] = {
			mode: "ready",
			event: delivery
		};

		record.events[activationId] = {
			mode: "paused",
			event: activation
		};

		record.evidence.identities[deliveryId] =
			events.fingerprint(delivery);

		record.evidence.identities[activationId] =
			events.fingerprint(activation);

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-wal-kind": "continuation",
			text: JSON.stringify(record)
		}));

		return title;
	}

	return {
		wiki: wiki,
		platform: platform,
		runtime: runtime,
		publish: publish
	};
}

function testModesAndOwnershipAreIndependent(tw) {
	var f = fixture(tw);
	var title = f.publish();

	var view = f.runtime.inspect().obligations;

	assert(view.complete);
	assert(view.journals.total === 1);
	assert(view.journals.owned === 1);
	assert(view.waiting.deliveries.ready === 1);
	assert(view.waiting.activations.paused === 1);
	assert(view.materializations === 0);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(title),
		{ "clerus-custody": "user" }
	));

	view = f.runtime.inspect().obligations;

	assert(view.journals.owned === 0);
	assert(view.journals.notOwned === 1);
	assert(view.waiting.deliveries.ready === 1);
	assert(view.waiting.activations.paused === 1);
}

function testUnavailableAttemptsDoNotMultiplyObligations(tw) {
	var f = fixture(tw);
	f.publish();

	var first = f.runtime.drainFlows();
	var second = f.runtime.drainFlows();

	assert(first.summary.complete);
	assert(second.summary.complete);
	assert(first.summary.waiting.deliveries.ready === 1);
	assert(second.summary.waiting.deliveries.ready === 1);
	assert(second.summary.waiting.activations.paused === 1);
}

function testUnsupportedLocalJournalMakesSummaryIncomplete(tw) {
	var f = fixture(tw);
	f.publish();

	var title =
		"$:/clerus/wal/" + f.platform + "/summary-unknown";

	f.wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": "user",
		"clerus-wal-kind": "future-kind",
		text: JSON.stringify({
			version: 99,
			kind: "future-kind",
			platform: f.platform
		})
	}));

	var view = f.runtime.inspect().obligations;

	assert(!view.complete);
	assert(view.journals.total === 2);
	assert(view.waiting.deliveries.ready === 1);
	assert(view.unreadable.length === 1);
	assert(view.unreadable[0].title === title);
}

function testForeignJournalIsOutsideLocalSummary(tw) {
	var f = fixture(tw);
	f.publish();

	var other = f.platform === "browser" ? "node" : "browser";

	f.wiki.addTiddler(new tw.Tiddler({
		title: "$:/clerus/wal/" + other + "/unknown",
		type: "application/json",
		"clerus-custody": other,
		"clerus-wal-kind": "future-kind",
		text: JSON.stringify({
			version: 99,
			kind: "future-kind",
			platform: other
		})
	}));

	var view = f.runtime.inspect().obligations;

	assert(view.complete);
	assert(view.journals.total === 1);
	assert(view.unreadable.length === 0);

	/*
		Local reporting scope does not relax global conservative
		recognition used by barriers and collection.
	*/
	assert(!f.runtime.inspect().retention.complete);
}

function testReturnedViewIsIsolated(tw) {
	var f = fixture(tw);
	f.publish();

	var view = f.runtime.inspect().obligations;

	view.waiting.deliveries.ready = 100;
	view.unreadable.push({ title: "invented" });

	var fresh = f.runtime.inspect().obligations;

	assert(fresh.waiting.deliveries.ready === 1);
	assert(fresh.unreadable.length === 0);
}

exports.run = function (tw) {
	var cases = [
		["event mode and journal ownership are independent", testModesAndOwnershipAreIndependent],
		["attempts do not multiply pending obligations", testUnavailableAttemptsDoNotMultiplyObligations],
		["unknown local WAL makes summary incomplete", testUnsupportedLocalJournalMakesSummaryIncomplete],
		["foreign WAL is outside local summary", testForeignJournalIsOutsideLocalSummary],
		["summary values are isolated", testReturnedViewIsIsolated]
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