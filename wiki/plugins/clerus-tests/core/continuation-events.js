/*\
title: $:/plugins/clerus/tests/core/continuation-events.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var stores = require("$:/plugins/clerus/core/store.js");
var retention = require("$:/plugins/clerus/core/retention.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var recipient = "$:/clerus/jobs/event-recipient";
	var referenced = "$:/clerus/jobs/event-reference";
	var target = "Continuation Event Target";
	var calls = 0;
	var sequence = 0;

	[recipient, referenced].forEach(function (title) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "event-test",
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: {}
				}
			})
		}));
	});

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		text: "initial"
	}));

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		newId: function () {
			sequence++;
			return "event-test-id-" +
				String(sequence).padStart(12, "0");
		},
		resolveExecutor: function () {
			return function () {
				calls++;
			};
		}
	});

	var before = runtime.store.read(target).fields;

	var work = {
		version: 2,
		id: "event-work-identity-00001",
		checks: [],
		transitions: [
			stores.transition(
				target,
				before,
				Object.assign({}, before, { text: "completed" })
			)
		],
		blocks: [],
		emits: [{
			id: "event-delivery-identity-01",
			event: {
				kind: "delivery",
				recipient: {
					title: recipient,
					executor: "event-test"
				},
				type: "order",
				registry: {
					reference: referenced,
					input: {
						form: "memo",
						data: 42
					}
				}
			}
		}]
	};

	return {
		wiki: wiki,
		runtime: runtime,
		target: target,
		work: work,
		recipient: recipient,
		referenced: referenced,
		calls: function () {
			return calls;
		}
	};
}

function testPublication(tw) {
	var f = fixture(tw);
	var title = f.runtime.continuations.accept(f.work);

	var before = JSON.parse(f.wiki.getTiddlerText(title));

	assert(before.work);
	assert(Object.keys(before.events).length === 0);

	var report = f.runtime.recover();

	assert(report.entries.some(function (entry) {
		return entry.title === title && entry.status === "pending";
	}));

	var record = JSON.parse(f.wiki.getTiddlerText(title));
	var id = f.work.emits[0].id;

	assert(record.work === null);
	assert(Object.keys(record.events).length === 1);
	assert(record.events[id].mode === "ready");
	assert(record.events[id].event.registry.input.data === 42);
	assert(record.evidence.identities[id]);
	assert(f.wiki.getTiddlerText(f.target) === "completed");
	assert(f.calls() === 0);

	f.runtime.recover();

	record = JSON.parse(f.wiki.getTiddlerText(title));
	assert(Object.keys(record.events).length === 1);
}

function testPublicationFailure(tw) {
	var f = fixture(tw);
	var title = f.runtime.continuations.accept(f.work);
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		if (
			effect.title === title &&
			effect.after &&
			!injected
		) {
			var record = JSON.parse(effect.after.text);

			if (record.work === null) {
				injected = true;
				throw new Error("Before event publication");
			}
		}

		return originalApply.call(this, effect);
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
	assert(f.wiki.getTiddlerText(f.target) === "completed");

	var paused = f.wiki.getTiddler(title);
	var record = JSON.parse(paused.fields.text);

	assert(record.work);
	assert(Object.keys(record.events).length === 0);
	assert(paused.fields["clerus-custody"] === "user");

	f.wiki.addTiddler(new tw.Tiddler(
		paused,
		{ "clerus-custody": f.runtime.platform }
	));

	f.runtime.recover();

	record = JSON.parse(f.wiki.getTiddlerText(title));

	assert(record.work === null);
	assert(Object.keys(record.events).length === 1);
	assert(f.calls() === 0);
}

function testWaitingRetention(tw) {
	var f = fixture(tw);
	var title = f.runtime.continuations.accept(f.work);

	f.runtime.recover();

	var loaded = f.wiki.getTiddler(title);
	var record = JSON.parse(loaded.fields.text);
	var id = f.work.emits[0].id;

	record.events[id].mode = "paused";

	f.wiki.addTiddler(new tw.Tiddler(loaded, {
		"clerus-custody": "user",
		text: JSON.stringify(record)
	}));

	var view = retention.evaluate({
		jobs: f.runtime.readJobs(),
		tiddlers: f.runtime.store.snapshot().materialized
	});

	assert(view.complete);

	[f.recipient, f.referenced].forEach(function (title) {
		assert(view.retained.some(function (entry) {
			return entry.title === title;
		}));
	});
}

function testEmissionOnlyWork(tw) {
	var f = fixture(tw);
	f.work.transitions = [];

	var title = f.runtime.continuations.accept(f.work);

	f.runtime.recover();

	var record = JSON.parse(f.wiki.getTiddlerText(title));

	assert(record.work === null);
	assert(Object.keys(record.events).length === 1);
	assert(f.wiki.getTiddlerText(f.target) === "initial");
	assert(f.calls() === 0);
}

exports.run = function (tw) {
	var cases = [
		["work publishes registered waiting events", testPublication],
		["failed publication preserves accepted work", testPublicationFailure],
		["paused events retain recipients and references", testWaitingRetention],
		["emission-only work is supported", testEmissionOnlyWork]
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