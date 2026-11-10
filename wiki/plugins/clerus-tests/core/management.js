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

function completedDemo(f) {
	var demo = f.adapter.command("demo");

	f.adapter.command("release", demo.journal);

	for (var index = 0; index < 3; index++) {
		f.adapter.command("deferred");
	}

	assert(!f.wiki.tiddlerExists(demo.journal));
	assert(f.record(demo.job).charter.status.phase === "completed");

	return demo;
}

function testMovePreparationDoesNotChangeJob(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();

		var demo = completedDemo(f);
		var before = f.wiki.getTiddlerText(demo.job);
		var custodyBefore = f.wiki.getTiddler(demo.job)
			.fields["clerus-custody"];

		var move = f.adapter.command("prepare-move", demo.job);
		var journal = f.record(move.journal);
		var effect = journal.work.transitions[0];
		var marker = JSON.parse(
			effect.after["clerus-custody-transfer"]
		);

		assert(
			f.wiki.getTiddler(move.journal)
				.fields["clerus-custody"] === "user"
		);
		assert(f.wiki.getTiddlerText(demo.job) === before);
		assert(
			f.wiki.getTiddler(demo.job)
				.fields["clerus-custody"] === custodyBefore
		);

		assert(effect.title === demo.job);
		assert(marker.journal === move.journal);
		assert(marker.work === journal.work.id);
		assert(marker.from === f.platform);
		assert(marker.to === move.to);

		f.adapter.command("service");

		// User custody must prevent execution of the prepared move.
		assert(
			f.wiki.getTiddler(demo.job)
				.fields["clerus-custody"] === f.platform
		);
	} finally {
		f.adapter.dispose();
	}
}

function testPreparedMoveMaterializes(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();

		var demo = completedDemo(f);
		var originalRegistry = f.wiki.getTiddlerText(demo.job);
		var move = f.adapter.command("prepare-move", demo.job);

		f.adapter.command("release", move.journal);

		var job = f.wiki.getTiddler(demo.job);
		var marker = JSON.parse(
			job.fields["clerus-custody-transfer"]
		);

		assert(job.fields["clerus-custody"] === move.to);
		assert(job.fields.text === originalRegistry);
		assert(marker.journal === move.journal);

		// Prototype retention is disabled in this fixture.
		assert(!f.wiki.tiddlerExists(move.journal));

		throws(function () {
			f.adapter.command("prepare-move", demo.job);
		}, "not locally owned");
	} finally {
		f.adapter.dispose();
	}
}

function testMoveDoesNotOverwriteChangedBaseline(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();

		var demo = completedDemo(f);
		var move = f.adapter.command("prepare-move", demo.job);

		var registry = f.record(demo.job);

		registry.charter.status = {
			phase: "operator-edited",
			completed: 3
		};

		f.wiki.addTiddler(new tw.Tiddler(
			f.wiki.getTiddler(demo.job),
			{ text: JSON.stringify(registry) }
		));

		f.adapter.command("release", move.journal);

		assert(
			f.wiki.getTiddler(demo.job)
				.fields["clerus-custody"] === f.platform
		);
		assert(
			f.record(demo.job).charter.status.phase ===
				"operator-edited"
		);
		assert(
			f.wiki.getTiddler(move.journal)
				.fields["clerus-custody"] === "user"
		);
		assert(f.record(move.journal).work !== null);
	} finally {
		f.adapter.dispose();
	}
}

function establishProjectDemo(f) {
	var project = f.adapter.command("project-demo");

	assert(!f.wiki.tiddlerExists(project.project));
	assert(!f.wiki.tiddlerExists(project.root));

	f.adapter.command("release", project.journal);

	var root = f.record(project.root);

	assert(root.charter.status.phase === "awaiting-resources");
	assert(root.charter.book.project === project.project);
	assert(root.mission.project === project.project);
	assert(root.mission.role.length === 0);

	return project;
}

function organizeProjectDemo(f, project) {
	var resources = f.adapter.command(
		"project-resources",
		project.root
	);

	// Preparation alone does not organize the project.
	assert(
		f.record(project.root).charter.status.phase ===
			"awaiting-resources"
	);

	f.adapter.command("release", resources.journal);

	var root = f.record(project.root);
	var workers = ["first", "second", "third"].map(function (segment) {
		var title = root["worker-" + segment];

		assert(typeof title === "string");
		assert(f.wiki.tiddlerExists(title));

		var worker = f.record(title);

		assert(worker.charter.status.phase === "waiting");
		assert(worker.mission.project === project.project);
		assert(worker.mission.role.join("/") === segment);

		return title;
	});

	assert(root.charter.status.phase === "running");
	assert(Object.keys(root.charter.status.results).length === 0);

	return {
		journal: resources.journal,
		workers: workers
	};
}

function assertProjectCompleted(f, project, organization) {
	var root = f.record(project.root);
	var results = root.charter.status.results;

	assert(root.charter.status.phase === "completed");
	assert(Object.keys(results).sort().join(",") === "first,second,third");

	assert(results.first.input === 2);
	assert(results.first.output === 4);
	assert(results.second.input === 3);
	assert(results.second.output === 9);
	assert(results.third.input === 5);
	assert(results.third.output === 25);

	organization.workers.forEach(function (title) {
		assert(f.record(title).charter.status.phase === "completed");
	});

	/*
	Incoming result memos were explicitly destroyed, rather than
	silently retained in the root's operational registry.
	*/
	assert(
		Object.keys(root).sort().join(",") ===
			"charter,mission,worker-first,worker-second,worker-third"
	);

	// In this fixture, exhausted WAL is deleted immediately.
	assert(!f.wiki.tiddlerExists(organization.journal));
}

function testProjectDemoLifecycle(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();

		var project = establishProjectDemo(f);
		var organization = organizeProjectDemo(f, project);

		/*
		Ordinary servicing must not execute the workers' deferred
		activations or manufacture their reports.
		*/
		f.adapter.command("service");

		assert(
			Object.keys(
				f.record(project.root).charter.status.results
			).length === 0
		);

		organization.workers.forEach(function (title) {
			assert(
				f.record(title).charter.status.phase === "waiting"
			);
		});

		f.adapter.command("deferred");

		assertProjectCompleted(f, project, organization);

		var view = f.adapter.command("inspect");
		var holders = view.missions.active.map(function (entry) {
			return entry.title;
		});

		assert(holders.indexOf(project.root) !== -1);

		organization.workers.forEach(function (title) {
			assert(
				holders.indexOf(title) !== -1,
				"Completed worker lost its retained assignment"
			);
		});

		assert(view.hierarchy.complete);
		assert(view.missions.complete);
	} finally {
		f.adapter.dispose();
	}
}

function testProjectDemoResumesAfterAdapterReplacement(tw) {
	var f = fixture(tw);
	var restarted = null;
	var sequence = 0;

	try {
		f.adapter.start();

		var project = establishProjectDemo(f);
		var organization = organizeProjectDemo(f, project);
		var rootBefore = f.wiki.getTiddlerText(project.root);

		f.adapter.dispose();

		restarted = management.create({
			tw: tw,
			wiki: f.wiki,
			platform: f.platform,
			prototypeWalReceipts: false,

			newId: function () {
				sequence++;

				return "project-demo-restart-" +
					String(sequence).padStart(12, "0");
			}
		});

		restarted.start();

		assert(
			f.wiki.getTiddlerText(project.root) === rootBefore
		);

		organization.workers.forEach(function (title) {
			assert(
				f.record(title).charter.status.phase === "waiting"
			);
		});

		restarted.command("deferred");

		assertProjectCompleted(f, project, organization);

		// No activation remains to repeat the reports.
		var completed = f.wiki.getTiddlerText(project.root);

		restarted.command("service");
		restarted.command("deferred");

		assert(
			f.wiki.getTiddlerText(project.root) === completed
		);
	} finally {
		if (restarted) {
			restarted.dispose();
		}

		f.adapter.dispose();
	}
}

function testProjectDemoRejectsRepeatedProvisioning(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();

		var project = establishProjectDemo(f);
		organizeProjectDemo(f, project);

		var before = f.wiki.getTiddlerText(project.root);
		var jobsBefore = f.wiki.filterTiddlers(
			"[all[tiddlers]prefix[$:/clerus/jobs/]sort[title]]"
		);

		throws(function () {
			f.adapter.command("project-resources", project.root);
		}, "not awaiting resources");

		assert(
			f.wiki.getTiddlerText(project.root) === before
		);
		assert(
			JSON.stringify(f.wiki.filterTiddlers(
				"[all[tiddlers]prefix[$:/clerus/jobs/]sort[title]]"
			)) === JSON.stringify(jobsBefore)
		);
	} finally {
		f.adapter.dispose();
	}
}

function testProjectCardUsesActualAssignments(tw) {
	var f = fixture(tw);
	var cards = require("$:/plugins/clerus/core/project-card.js");

	function read(project) {
		return cards.read({
			wiki: f.wiki,
			Tiddler: tw.Tiddler,
			platform: f.platform,
			project: project
		});
	}

	try {
		f.adapter.start();

		var project = establishProjectDemo(f);
		var organization = organizeProjectDemo(f, project);
		var before = f.wiki.getTiddlerText(project.root);

		var model = read(project.project);

		assert(model.error === null);
		assert(model.tree.assignment.title === project.root);
		assert(model.tree.children.length === 3);

		model.tree.children.forEach(function (node) {
			assert(node.assignment !== null);
			assert(
				organization.workers.indexOf(
					node.assignment.title
				) !== -1
			);
			assert(node.assignment.holder.view.readable);
			assert(node.assignment.holder.view.status.phase === "waiting");
		});

		// Reading the card must not execute or rewrite anything.
		assert(f.wiki.getTiddlerText(project.root) === before);

		f.adapter.command("deferred");

		model = read(project.project);

		assert(
			model.tree.assignment.holder.view.status.phase ===
				"completed"
		);

		model.tree.children.forEach(function (node) {
			assert(
				node.assignment.holder.view.status.phase ===
					"completed"
			);
		});

		/*
		Removing a task must not make its still-current assignment
		disappear from the organizational view.
		*/
		var tree = JSON.parse(
			f.wiki.getTiddlerText(project.project)
		);

		delete tree.parts.first;

		f.wiki.addTiddler(new tw.Tiddler(
			f.wiki.getTiddler(project.project),
			{ text: JSON.stringify(tree) }
		));

		model = read(project.project);

		assert(model.tree.children.length === 2);
		assert(model.outsideTree.some(function (entry) {
			return entry.role.join("/") === "first";
		}));
	} finally {
		f.adapter.dispose();
	}
}

function testProjectCardActionsFollowCustody(tw) {
	var f = fixture(tw);
	var cards = require("$:/plugins/clerus/core/project-card.js");

	function read(project) {
		return cards.read({
			wiki: f.wiki,
			Tiddler: tw.Tiddler,
			platform: f.platform,
			project: project
		});
	}

	try {
		f.adapter.start();

		var project = establishProjectDemo(f);
		organizeProjectDemo(f, project);
		f.adapter.command("deferred");

		var model = read(project.project);
		var root = model.tree.assignment.holder;

		assert(root.locallyOwned);
		assert(root.actions.prepareMove);
		assert(!root.actions.resume);

		var move = f.adapter.command("prepare-move", project.root);
		f.adapter.command("release", move.journal);

		model = read(project.project);
		root = model.tree.assignment.holder;

		// The assignment remains current across relocation.
		assert(root.title === project.root);
		assert(!root.locallyOwned);
		assert(!root.actions.prepareMove);
		assert(!root.actions.resume);

		// Administrative suspension without a transfer marker.
		var fields = f.wiki.getTiddler(project.root);

		f.wiki.addTiddler(new tw.Tiddler(fields, {
			"clerus-custody": "user",
			"clerus-suspended": "yes",
			"clerus-custody-transfer": undefined
		}));

		model = read(project.project);
		root = model.tree.assignment.holder;

		assert(root.suspended);
		assert(root.actions.resume);
		assert(!root.actions.prepareMove);
	} finally {
		f.adapter.dispose();
	}
}

function testProjectCardRendersWithoutExecutingWork(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();

		var project = establishProjectDemo(f);
		var organization = organizeProjectDemo(f, project);

		var tree = f.record(project.project);

		tree.task.note =
			"<script>card-escape-sentinel</script>";

		f.wiki.addTiddler(new tw.Tiddler(
			f.wiki.getTiddler(project.project),
			{ text: JSON.stringify(tree) }
		));

		var before = f.wiki.getTiddlerText(project.root);
		var reportBefore = f.wiki.getTiddlerText(
			f.adapter.reportTitle
		);

		var html = f.wiki.renderText(
			"text/html",
			"text/vnd.tiddlywiki",
			"<$clerus-project-card project=" +
				JSON.stringify(project.project) +
				"/>"
		);

		assert(html.indexOf("Корневая задача") !== -1);
		assert(html.indexOf("Подготовить переезд") !== -1);
		assert(html.indexOf(project.root) !== -1);
		assert(html.indexOf("card-escape-sentinel") !== -1);

		// Task data must be text, not executable HTML.
		assert(
			html.indexOf(
				"<script>card-escape-sentinel</script>"
			) === -1
		);

		assert(f.wiki.getTiddlerText(project.root) === before);
		assert(
			f.wiki.getTiddlerText(f.adapter.reportTitle) ===
				reportBefore
		);

		organization.workers.forEach(function (title) {
			assert(
				f.record(title).charter.status.phase === "waiting"
			);
		});
	} finally {
		f.adapter.dispose();
	}
}

function testProjectDemoClosesOrganization(tw) {
	var f = fixture(tw);
	var cards = require("$:/plugins/clerus/core/project-card.js");

	try {
		f.adapter.start();

		var project = establishProjectDemo(f);
		var organization = organizeProjectDemo(f, project);

		f.adapter.command("deferred");
		assertProjectCompleted(f, project, organization);

		var resultsBefore = JSON.stringify(
			f.record(project.root).charter.status.results
		);

		var close = f.adapter.command(
			"project-close",
			project.root
		);

		// Preparation has not changed the organization.
		assert(
			f.record(project.root).charter.status.phase ===
				"completed"
		);
		assert(f.record(project.root)["worker-first"]);

		f.adapter.command("release", close.journal);

		var root = f.record(project.root);

		assert(root.charter.status.phase === "closed");
		assert(
			JSON.stringify(root.charter.status.results) ===
				resultsBefore
		);
		assert(
			Object.keys(root).sort().join(",") === "charter,mission"
		);
		assert(Object.keys(root.mission.children).length === 0);

		var inspection = f.adapter.command("inspect");
		var active = inspection.missions.active.filter(function (entry) {
			return entry.project === project.project;
		});

		assert(active.length === 1);
		assert(active[0].title === project.root);
		assert(active[0].role.length === 0);

		organization.workers.forEach(function (title) {
			// Automatic collection is still disabled.
			assert(f.wiki.tiddlerExists(title));

			assert(!inspection.missions.active.some(function (entry) {
				return entry.title === title &&
					entry.project === project.project;
			}));
		});

		var card = cards.read({
			wiki: f.wiki,
			Tiddler: tw.Tiddler,
			platform: f.platform,
			project: project.project
		});

		assert(card.tree.assignment.title === project.root);

		card.tree.children.forEach(function (node) {
			assert(node.assignment === null);
		});

		throws(function () {
			f.adapter.command("project-close", project.root);
		}, "Only a completed project");
	} finally {
		f.adapter.dispose();
	}
}

function testProjectDemoCannotCloseWhileRunning(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();

		var project = establishProjectDemo(f);
		var organization = organizeProjectDemo(f, project);
		var before = f.wiki.getTiddlerText(project.root);

		throws(function () {
			f.adapter.command("project-close", project.root);
		}, "Only a completed project");

		assert(f.wiki.getTiddlerText(project.root) === before);

		organization.workers.forEach(function (title) {
			assert(
				f.record(title).charter.status.phase === "waiting"
			);
		});
	} finally {
		f.adapter.dispose();
	}
}

function testClosedProjectWorkersCanBeCollected(tw) {
	var f = fixture(tw);
	var retentionView = require(
		"$:/plugins/clerus/core/retention-view.js"
	);

	function readRetention() {
		return retentionView.read({
			wiki: f.wiki,
			Tiddler: tw.Tiddler,
			platform: f.platform
		});
	}

	try {
		f.adapter.start();

		var project = establishProjectDemo(f);
		var organization = organizeProjectDemo(f, project);

		// Running workers have both assignments and pending work.
		var running = readRetention();

		organization.workers.forEach(function (title) {
			var job = running.jobs.find(function (entry) {
				return entry.title === title;
			});

			assert(job);
			assert(job.reasons.some(function (reason) {
				return reason.kind === "active-mission";
			}));
			assert(job.reasons.some(function (reason) {
				return reason.kind === "waiting-event";
			}));
		});

		var early = f.adapter.command("collect");

		assert(early.removed.length === 0);

		f.adapter.command("deferred");

		// Completed workers remain assigned and referenced.
		var completed = f.adapter.command("collect");

		assert(completed.removed.length === 0);

		var close = f.adapter.command("project-close", project.root);
		f.adapter.command("release", close.journal);

		var before = readRetention();

		assert(before.complete);
		assert(before.valid);

		organization.workers.forEach(function (title) {
			var job = before.jobs.find(function (entry) {
				return entry.title === title;
			});

			assert(job);
			assert(job.reasons.length === 0);
			assert(job.analysisCandidate);
			assert(job.locallyOwned);
		});

		var rootBefore = f.wiki.getTiddlerText(project.root);
		var projectBefore = f.wiki.getTiddlerText(project.project);

		var collected = f.adapter.command("collect");

		assert(collected.blocked.length === 0);
		assert(collected.failures.length === 0);
		assert(collected.removed.length === organization.workers.length);

		organization.workers.forEach(function (title) {
			assert(collected.removed.indexOf(title) !== -1);
			assert(!f.wiki.tiddlerExists(title));
		});

		assert(f.wiki.getTiddlerText(project.root) === rootBefore);
		assert(f.wiki.getTiddlerText(project.project) === projectBefore);

		var after = readRetention();
		var root = after.jobs.find(function (entry) {
			return entry.title === project.root;
		});

		assert(root);
		assert(root.reasons.some(function (reason) {
			return reason.kind === "active-mission";
		}));

		// A second collection has nothing more to remove.
		assert(f.adapter.command("collect").removed.length === 0);
	} finally {
		f.adapter.dispose();
	}
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
		["management: disposal stops the automatic timer", testDisposeStopsAutomaticTimer],
		["management: move preparation preserves the job", testMovePreparationDoesNotChangeJob],
		["management: prepared move changes custody without changing registry", testPreparedMoveMaterializes],
		["management: move cannot overwrite a changed baseline", testMoveDoesNotOverwriteChangedBaseline],
		["management: project organizes workers and aggregates deferred reports", testProjectDemoLifecycle],
		["management: project resumes after adapter replacement", testProjectDemoResumesAfterAdapterReplacement],
		["management: project rejects repeated provisioning", testProjectDemoRejectsRepeatedProvisioning],
		["management: project card follows actual assignments without executing work", testProjectCardUsesActualAssignments],
		["management: project card actions follow local custody", testProjectCardActionsFollowCustody],
		["management: project card renders escaped data without executing work", testProjectCardRendersWithoutExecutingWork],
		["management: closing project revokes workers but preserves results", testProjectDemoClosesOrganization],
		["management: running project cannot be closed", testProjectDemoCannotCloseWhileRunning],
		["management: collection removes released workers and preserves project results", testClosedProjectWorkersCanBeCollected]
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