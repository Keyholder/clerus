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
	var timers = new Map();
	var timerSequence = 0;

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
		},

		setTimer: function (callback, milliseconds) {
			timerSequence++;

			timers.set(timerSequence, {
				callback: callback,
				milliseconds: milliseconds
			});

			return timerSequence;
		},

		clearTimer: function (handle) {
			timers.delete(handle);
		},

		prototypeWalReceipts: false
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
		},

		timerCount: function () {
			return timers.size;
		},

		runTimer: function () {
			assert(timers.size === 1, "Expected one automatic timer");

			var entry = timers.entries().next().value;
			timers.delete(entry[0]);

			assert(entry[1].milliseconds === 1000);
			entry[1].callback();
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

function pausedActivation(f, tw) {
	var demo = f.adapter.command("demo");

	f.adapter.command("release", demo.journal);
	f.adapter.command("hold", demo.journal);

	var record = f.record(demo.journal);
	var ids = Object.keys(record.events);

	assert(ids.length === 1);

	record.events[ids[0]].mode = "paused";
	record.diagnostics.push({
		event: ids[0],
		phase: "reaction",
		error: {
			name: "Error",
			message: "Synthetic repair fixture"
		}
	});

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(demo.journal),
		{ text: JSON.stringify(record) }
	));

	return {
		journal: demo.journal,
		job: demo.job,
		id: ids[0]
	};
}

function throws(fn, fragment) {
	var caught = null;

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

function testRetryPreservesNormativeContent(tw) {
	var f = fixture(tw);
	f.adapter.start();

	var paused = pausedActivation(f, tw);
	var before = f.record(paused.journal);

	f.adapter.command("retry", paused.journal, paused.id);

	var after = f.record(paused.journal);

	assert(
		f.wiki.getTiddler(paused.journal)
			.fields["clerus-custody"] === "user"
	);
	assert(after.events[paused.id].mode === "ready");

	/*
	After accounting for the one permitted change, the whole
	normalized continuation must still be identical.
	*/
	after.events[paused.id].mode = "paused";

	assert(JSON.stringify(after) === JSON.stringify(before));

	f.adapter.dispose();
}

function testRetryDoesNotExecuteUntilRelease(tw) {
	var f = fixture(tw);
	f.adapter.start();

	var paused = pausedActivation(f, tw);

	f.adapter.command("retry", paused.journal, paused.id);

	f.notify([paused.journal]);
	f.flush();

	f.adapter.command("service");
	f.adapter.command("deferred");

	assert(f.record(paused.job).charter.status.completed === 0);

	f.adapter.command("release", paused.journal);

	// Release performs delivery, not deferred activation.
	assert(f.record(paused.job).charter.status.completed === 0);

	f.adapter.command("deferred");

	assert(f.record(paused.job).charter.status.completed === 1);

	f.adapter.dispose();
}

function testRetryRejectsInvalidStateWithoutChangingWal(tw) {
	var f = fixture(tw);
	f.adapter.start();

	var paused = pausedActivation(f, tw);
	var before = f.wiki.getTiddlerText(paused.journal);

	throws(function () {
		f.adapter.command(
			"retry",
			paused.journal,
			"management-unknown-event-0001"
		);
	}, "Select a paused event");

	assert(f.wiki.getTiddlerText(paused.journal) === before);

	f.adapter.command("retry", paused.journal, paused.id);
	before = f.wiki.getTiddlerText(paused.journal);

	throws(function () {
		f.adapter.command("retry", paused.journal, paused.id);
	}, "Select a paused event");

	assert(f.wiki.getTiddlerText(paused.journal) === before);

	// Restore a paused event, but give the WAL to the runtime.
	var record = f.record(paused.journal);
	record.events[paused.id].mode = "paused";

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(paused.journal),
		{
			"clerus-custody": f.platform,
			text: JSON.stringify(record)
		}
	));

	before = f.wiki.getTiddlerText(paused.journal);

	throws(function () {
		f.adapter.command("retry", paused.journal, paused.id);
	}, "under user custody");

	assert(f.wiki.getTiddlerText(paused.journal) === before);
	assert(
		f.wiki.getTiddler(paused.journal)
			.fields["clerus-custody"] === f.platform
	);

	f.adapter.dispose();
}

function testSuspensionRepairAndRetry(tw) {
	var f = fixture(tw);
	f.adapter.start();

	var demo = f.adapter.command("demo");
	f.adapter.command("release", demo.journal);

	/*
	Simulate an operator edit that leaves valid JSON but breaks
	the demo executor's expectations.
	*/
	var registry = f.record(demo.job);
	registry.charter.status = null;

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(demo.job),
		{ text: JSON.stringify(registry) }
	));

	f.adapter.command("deferred");

	var job = f.wiki.getTiddler(demo.job);
	var journal = f.record(demo.journal);
	var ids = Object.keys(journal.events);

	assert(job.fields["clerus-custody"] === "user");
	assert(job.fields["clerus-suspended"] === "yes");
	assert(ids.length === 1);

	var eventId = ids[0];

	assert(journal.events[eventId].mode === "paused");
	assert(
		f.wiki.getTiddler(demo.journal)
			.fields["clerus-custody"] === "user"
	);

	var eventBefore = JSON.stringify(journal.events[eventId].event);
	var identityBefore = journal.evidence.identities[eventId];

	// Repair the executor's operational state under user custody.
	registry = f.record(demo.job);
	registry.charter.status = {
		phase: "waiting",
		completed: 0
	};

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(demo.job),
		{ text: JSON.stringify(registry) }
	));

	/*
	Keep the WAL under user custody while resuming the job.
	The resumption notification must not replay the failed tick.
	*/
	f.adapter.command("resume", demo.job);

	job = f.wiki.getTiddler(demo.job);

	assert(job.fields["clerus-custody"] === f.platform);
	assert(job.fields["clerus-suspended"] !== "yes");
	assert(f.record(demo.job).charter.status.completed === 0);

	journal = f.record(demo.journal);

	assert(journal.events[eventId].mode === "paused");

	// Prepare the original event for another attempt.
	f.adapter.command("retry", demo.journal, eventId);

	journal = f.record(demo.journal);

	assert(journal.events[eventId].mode === "ready");
	assert(
		JSON.stringify(journal.events[eventId].event) === eventBefore
	);
	assert(journal.evidence.identities[eventId] === identityBefore);

	f.adapter.command("release", demo.journal);

	assert(f.record(demo.job).charter.status.completed === 0);

	f.adapter.command("deferred");

	assert(f.record(demo.job).charter.status.completed === 1);

	journal = f.record(demo.journal);

	assert(
		!Object.prototype.hasOwnProperty.call(
			journal.events,
			eventId
		)
	);

	// Historical diagnostics survive successful repair.
	assert(journal.diagnostics.some(function (entry) {
		return entry.event === eventId;
	}));

	f.adapter.dispose();
}

function testResumeRejectsActiveJob(tw) {
	var f = fixture(tw);
	f.adapter.start();

	var demo = f.adapter.command("demo");
	f.adapter.command("release", demo.journal);

	var before = JSON.stringify(
		f.wiki.getTiddler(demo.job).fields
	);

	throws(function () {
		f.adapter.command("resume", demo.job);
	}, "suspended persistent job");

	assert(
		JSON.stringify(f.wiki.getTiddler(demo.job).fields) === before
	);

	f.adapter.dispose();
}

function testAutomaticPassesAreExplicitAndBounded(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();

		var demo = f.adapter.command("demo");
		f.adapter.command("release", demo.journal);

		assert(f.timerCount() === 0);

		f.adapter.command("automatic-start");
		f.adapter.command("automatic-start");

		// Enabling twice must neither run a tick nor duplicate timers.
		assert(f.timerCount() === 1);
		assert(f.record(demo.job).charter.status.completed === 0);

		for (var step = 1; step <= 3; step++) {
			f.runTimer();

			assert(
				f.record(demo.job).charter.status.completed === step
			);
			assert(f.timerCount() === 1);
		}

		assert(!f.wiki.tiddlerExists(demo.journal));

		f.adapter.command("automatic-stop");

		assert(f.timerCount() === 0);
		assert(
			f.record(f.adapter.reportTitle).automatic.enabled === false
		);
	} finally {
		f.adapter.dispose();
	}
}

function testAutomaticStopPreservesPendingActivation(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();

		var demo = f.adapter.command("demo");
		f.adapter.command("release", demo.journal);

		f.adapter.command("automatic-start");
		f.runTimer();

		assert(f.record(demo.job).charter.status.completed === 1);

		var before = f.wiki.getTiddlerText(demo.journal);

		f.adapter.command("automatic-stop");

		assert(f.timerCount() === 0);
		assert(f.wiki.getTiddlerText(demo.journal) === before);

		// Manual execution remains available after stopping the driver.
		f.adapter.command("deferred");

		assert(f.record(demo.job).charter.status.completed === 2);
		assert(f.timerCount() === 0);
	} finally {
		f.adapter.dispose();
	}
}

function testDisposeStopsAutomaticTimer(tw) {
	var f = fixture(tw);

	f.adapter.start();
	f.adapter.command("automatic-start");

	assert(f.timerCount() === 1);

	f.adapter.dispose();

	assert(f.timerCount() === 0);
	assert(f.listenerCount() === 0);
}

exports.run = function (tw) {
	var cases = [
		["management: start and dispose are idempotent", testStartIsIdempotent],
		["management: demonstration starts under user custody", testDemoStartsUnderUserCustody],
		["management: release preserves deferred pass boundaries", testReleaseAndDeferredBoundary],
		["management: own notifications do not repeat service", testOwnNotificationsDoNotRepeatService],
		["management: external WAL changes schedule service", testExternalWalChangeSchedulesService],
		["management: release does not resume paused events", testReleasePreservesPausedEvent],
		["management: dispose cancels scheduled execution", testDisposeCancelsScheduledExecution],
		["management: retry preserves normative content and diagnostics", testRetryPreservesNormativeContent],
		["management: retry waits for separate release", testRetryDoesNotExecuteUntilRelease],
		["management: invalid retry does not change WAL", testRetryRejectsInvalidStateWithoutChangingWal],
		["management: suspended job repair and original event retry", testSuspensionRepairAndRetry],
		["management: active job cannot be administratively resumed", testResumeRejectsActiveJob],
		["management: automatic passes are explicit and bounded", testAutomaticPassesAreExplicitAndBounded],
		["management: stopping automation preserves pending activation", testAutomaticStopPreservesPendingActivation],
		["management: disposal stops the automatic timer", testDisposeStopsAutomaticTimer]
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