/*\
title: $:/plugins/clerus/tests/core/management.js
type: application/javascript
module-type: library
\*/

"use strict";

var management = require("$:/plugins/clerus/core/management.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var callbacks = [];
	var listeners = [];
	var sequence = 0;

	/*
	Intercept only this isolated wiki's change subscription.

	The tests explicitly present change notifications, including
	delayed notifications about writes already serviced.
	*/
	wiki.addEventListener = function (type, listener) {
		assert(type === "change");
		listeners.push(listener);
	};

	wiki.removeEventListener = function (type, listener) {
		assert(type === "change");

		listeners = listeners.filter(function (current) {
			return current !== listener;
		});
	};

	var adapter = management.create({
		tw: tw,
		wiki: wiki,
		platform: platform,

		newId: function () {
			sequence++;

			return "management-test-" +
				String(sequence).padStart(12, "0");
		},

		schedule: function (callback) {
			callbacks.push(callback);
		}
	});

	function notify(titles) {
		var changes = Object.create(null);

		titles.forEach(function (title) {
			changes[title] = { modified: true };
		});

		listeners.slice().forEach(function (listener) {
			listener(changes);
		});
	}

	function flush() {
		var count = 0;

		while (callbacks.length > 0) {
			count++;

			assert(count <= 20, "Management scheduling did not settle");
			callbacks.shift()();
		}

		return count;
	}

	function record(title) {
		var tiddler = wiki.getTiddler(title);

		assert(tiddler, "Missing tiddler: " + title);
		return JSON.parse(tiddler.fields.text);
	}

	return {
		wiki: wiki,
		platform: platform,
		adapter: adapter,
		notify: notify,
		flush: flush,
		record: record,

		listenerCount: function () {
			return listeners.length;
		},

		scheduledCount: function () {
			return callbacks.length;
		}
	};
}

function testStartIsIdempotent(tw) {
	var f = fixture(tw);

	f.adapter.start();
	f.adapter.start();

	assert(f.listenerCount() === 1);
	assert(f.record(f.adapter.reportTitle).command === "service");

	f.adapter.dispose();
	f.adapter.dispose();

	assert(f.listenerCount() === 0);
}

function testDemoStartsUnderUserCustody(tw) {
	var f = fixture(tw);
	f.adapter.start();

	var demo = f.adapter.command("demo");
	var journal = f.wiki.getTiddler(demo.journal);
	var record = f.record(demo.journal);

	assert(journal.fields["clerus-custody"] === "user");
	assert(record.work !== null);
	assert(record.work.emits.length === 1);
	assert(Object.keys(record.events).length === 0);
	assert(!f.wiki.tiddlerExists(demo.job));

	f.adapter.command("service");

	assert(!f.wiki.tiddlerExists(demo.job));
	assert(
		f.wiki.getTiddler(demo.journal)
			.fields["clerus-custody"] === "user"
	);

	f.adapter.dispose();
}

function testReleaseAndDeferredBoundary(tw) {
	var f = fixture(tw);
	f.adapter.start();

	var demo = f.adapter.command("demo");
	f.adapter.command("release", demo.journal);

	var registry = f.record(demo.job);
	var journal = f.record(demo.journal);
	var ids = Object.keys(journal.events);

	assert(registry.charter.status.phase === "waiting");
	assert(registry.charter.status.completed === 0);
	assert(journal.work === null);
	assert(ids.length === 1);
	assert(journal.events[ids[0]].event.kind === "activation");

	f.adapter.command("service");

	assert(f.record(demo.job).charter.status.completed === 0);

	for (var step = 1; step <= 3; step++) {
		f.adapter.command("deferred");

		registry = f.record(demo.job);
		assert(registry.charter.status.completed === step);

		if (step < 3) {
			journal = f.record(demo.journal);
			ids = Object.keys(journal.events);

			assert(ids.length === 1);
			assert(journal.events[ids[0]].event.kind === "activation");
			assert(registry.charter.status.phase === "waiting");
		}
	}

	assert(registry.charter.status.phase === "completed");
	assert(!f.wiki.tiddlerExists(demo.journal));

	// Automatic collection is disabled.
	assert(f.wiki.tiddlerExists(demo.job));

	f.adapter.dispose();
}

function testOwnNotificationsDoNotRepeatService(tw) {
	var f = fixture(tw);
	f.adapter.start();

	var demo = f.adapter.command("demo");
	f.adapter.command("release", demo.journal);
	f.adapter.command("inspect");

	/*
	A delayed TW5 notification may arrive after the command has
	already captured the final WAL state.
	*/
	f.notify([demo.journal]);
	f.notify([demo.journal]);

	assert(f.scheduledCount() === 1);
	assert(f.flush() === 1);

	// No automatic service replaced the explicit inspection report.
	assert(f.record(f.adapter.reportTitle).command === "inspect");
	assert(f.record(demo.job).charter.status.completed === 0);

	f.adapter.dispose();
}

function testExternalWalChangeSchedulesService(tw) {
	var f = fixture(tw);
	f.adapter.start();

	var demo = f.adapter.command("demo");

	/*
	Emulate a standard-widget custody edit rather than calling
	the management release command.
	*/
	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(demo.journal),
		{ "clerus-custody": f.platform }
	));

	f.notify([demo.journal]);
	f.notify([demo.journal]);

	assert(f.scheduledCount() === 1);
	f.flush();

	assert(f.wiki.tiddlerExists(demo.job));
	assert(f.record(demo.job).charter.status.completed === 0);
	assert(f.record(f.adapter.reportTitle).command === "service");

	// The notification about servicing that WAL is not new input.
	f.adapter.command("inspect");
	f.notify([demo.journal]);
	f.flush();

	assert(f.record(f.adapter.reportTitle).command === "inspect");

	f.adapter.dispose();
}

function testReleasePreservesPausedEvent(tw) {
	var f = fixture(tw);
	f.adapter.start();

	var demo = f.adapter.command("demo");
	f.adapter.command("release", demo.journal);
	f.adapter.command("hold", demo.journal);

	var record = f.record(demo.journal);
	var ids = Object.keys(record.events);

	assert(ids.length === 1);
	record.events[ids[0]].mode = "paused";

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(demo.journal),
		{ text: JSON.stringify(record) }
	));

	f.adapter.command("release", demo.journal);
	f.adapter.command("deferred");

	record = f.record(demo.journal);

	assert(record.events[ids[0]].mode === "paused");
	assert(f.record(demo.job).charter.status.completed === 0);

	f.adapter.dispose();
}

function testDisposeCancelsScheduledExecution(tw) {
	var f = fixture(tw);
	f.adapter.start();

	var demo = f.adapter.command("demo");

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(demo.journal),
		{ "clerus-custody": f.platform }
	));

	f.notify([demo.journal]);
	assert(f.scheduledCount() === 1);

	f.adapter.dispose();
	f.flush();

	assert(f.listenerCount() === 0);
	assert(!f.wiki.tiddlerExists(demo.job));
	assert(f.wiki.tiddlerExists(demo.journal));
}

exports.run = function (tw) {
	var cases = [
		["management: start and dispose are idempotent", testStartIsIdempotent],
		["management: demonstration starts under user custody", testDemoStartsUnderUserCustody],
		["management: release preserves deferred pass boundaries", testReleaseAndDeferredBoundary],
		["management: own notifications do not repeat service", testOwnNotificationsDoNotRepeatService],
		["management: external WAL changes schedule service", testExternalWalChangeSchedulesService],
		["management: release does not resume paused events", testReleasePreservesPausedEvent],
		["management: dispose cancels scheduled execution", testDisposeCancelsScheduledExecution]
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