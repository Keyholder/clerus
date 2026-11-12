/*\
title: $:/plugins/clerus/tests/core/persistent-observation.js
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

function throws(fn) {
	var caught = null;

	try {
		fn();
	} catch (error) {
		caught = error;
	}

	assert(caught, "Expected an exception");
	return caught;
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/persistent-observation-watcher";
	var target = "Persistent Observation Target";
	var sequence = 0;
	var calls = [];

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "persistent-observation-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { count: 0 }
			},
			document: target
		})
	}));

	function write(value) {
		wiki.addTiddler(new tw.Tiddler({
			title: target,
			text: value
		}));
	}

	write("initial");

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "persistent-observation-" +
				String(sequence).padStart(12, "0");
		},

		resolveExecutor: function () {
			return function (event, operational) {
				assert(event.type === "document-change");

				calls.push(event.id);

				operational.get("charter").setStatus({
					count: calls.length,
					text: operational.get(event.keys[0]).text()
				});
			};
		}
	});

	function isRegistration(effect) {
		if (
			!effect.after ||
			effect.after["clerus-wal-kind"] !== "continuation"
		) {
			return false;
		}

		var record = JSON.parse(effect.after.text);

		return record.work !== null &&
			record.work.emits.some(function (emission) {
				return emission.event.kind === "notification";
			});
	}

	return {
		wiki: wiki,
		title: title,
		target: target,
		runtime: runtime,
		calls: calls,
		write: write,
		isRegistration: isRegistration,

		identitiesAllocated: function () {
			return sequence;
		}
	};
}

function testPersistentObservation(tw) {
	var f = fixture(tw);

	assert(f.runtime.observe().length === 0);

	f.write("changed");

	assert(f.calls.length === 0);

	f.runtime.observe();

	assert(f.calls.length === 1);

	var registry = JSON.parse(f.wiki.getTiddlerText(f.title));

	assert(registry.charter.status.text === "changed");
	assert(f.runtime.inspect().observation.pendingRegistration === null);

	f.runtime.observe();

	assert(f.calls.length === 1);
}

function testUncertainRecordedRegistrationIsConfirmed(tw) {
	var f = fixture(tw);

	f.runtime.observe();
	f.write("changed");

	var originalApply = f.runtime.store.apply;
	var injected = false;
	var eventId = null;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (!injected && f.isRegistration(effect)) {
			injected = true;

			var record = JSON.parse(effect.after.text);
			eventId = record.work.emits[0].id;

			throw new Error("Interrupted after registration write");
		}

		return result;
	};

	try {
		var error = throws(function () {
			f.runtime.observe();
		});

		assert(error.acceptanceUncertain);
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(f.calls.length === 0);

	var pending = f.runtime.inspect().observation.pendingRegistration;

	assert(pending);
	assert(pending.uncertain);
	assert(pending.journal);

	var allocated = f.identitiesAllocated();
	var journalBefore = f.wiki.getTiddlerText(pending.journal);

	var diagnostic = f.runtime.observationStatus()
		.pendingRegistration;

	assert(diagnostic.uncertain);
	assert(!diagnostic.registered);
	assert(diagnostic.evidence.confirmed);
	assert(diagnostic.evidence.source === "accepted-work");
	assert(diagnostic.notifications.length === 1);
	assert(diagnostic.notifications[0].id === eventId);
	assert(
		diagnostic.notifications[0].recipient.title === f.title
	);

	/*
	Diagnostic values are detached, not references into the stage.
	*/
	diagnostic.notifications[0].notification.keys[0] = "tampered";

	var repeated = f.runtime.observationStatus()
		.pendingRegistration;

	assert(
		repeated.notifications[0].notification.keys[0] ===
			"document"
	);
	assert(repeated.uncertain);
	assert(!repeated.registered);
	assert(f.identitiesAllocated() === allocated);
	assert(f.calls.length === 0);
	assert(
		f.wiki.getTiddlerText(pending.journal) === journalBefore
	);

	// The next pass confirms the old registration, not a new batch.
	f.runtime.observe();

	assert(f.calls.length === 1);
	assert(f.calls[0] === eventId);
	assert(f.runtime.inspect().observation.pendingRegistration === null);

	f.runtime.observe();

	assert(f.calls.length === 1);
}

function testUncertainAbsenceDoesNotCreateAnotherBatch(tw) {
	var f = fixture(tw);

	f.runtime.observe();
	f.write("changed");

	var originalApply = f.runtime.store.apply;

	f.runtime.store.apply = function (effect) {
		if (f.isRegistration(effect)) {
			throw new Error("Registration write result unavailable");
		}

		return originalApply.call(this, effect);
	};

	try {
		throws(function () {
			f.runtime.observe();
		});
	} finally {
		f.runtime.store.apply = originalApply;
	}

	var allocated = f.identitiesAllocated();
	var diagnostic = f.runtime.observationStatus()
		.pendingRegistration;

	assert(diagnostic.uncertain);
	assert(!diagnostic.evidence.confirmed);
	assert(
		diagnostic.evidence.reason === "journal-not-materialized"
	);
	assert(diagnostic.notifications.length === 1);
	assert(f.identitiesAllocated() === allocated);

	var error = throws(function () {
		f.runtime.observe();
	});

	assert(error.acceptanceUncertain);
	assert(f.identitiesAllocated() === allocated);
	assert(f.calls.length === 0);

	throws(function () {
		f.runtime.resetObservation();
	});

	var collected = f.runtime.collect();

	assert(
		collected.blocked.indexOf(
			"observation-registration-unresolved"
		) !== -1
	);
	assert(f.wiki.tiddlerExists(f.title));
}

function groupFixture(tw, specifications) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var target = "Grouped Persistent Observation Target";
	var sequence = 0;
	var calls = [];
	var available = {};
	var titles = {};
	var handlers = {};

	specifications.forEach(function (specification) {
		var name = specification.name;
		var title = specification.persistent
			? "$:/clerus/jobs/group-observation-" + name
			: "$:/temp/clerus/jobs/" + platform +
				"/group-observation-" + name;
		var executor = "group-observation-" + name;

		titles[name] = title;
		available[name] = true;

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: { count: 0 }
				},
				document: target
			})
		}));

		handlers[executor] = function (event, operational) {
			if (
				event.type === "suspended" ||
				event.type === "dismissed" ||
				event.type === "resumed"
			) {
				return;
			}

			assert(event.type === "document-change");
			assert(event.title === title);
			assert(event.platform === platform);
			assert(event.keys.join(",") === "document");

			calls.push({
				name: name,
				id: event.id
			});

			if (specification.fail) {
				throw new Error("Grouped observer failed: " + name);
			}

			operational.get("charter").setStatus({
				count: calls.filter(function (call) {
					return call.name === name;
				}).length,
				text: operational.get(event.keys[0]).text()
			});
		};
	});

	function write(text) {
		wiki.addTiddler(new tw.Tiddler({
			title: target,
			text: text
		}));
	}

	function restart() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,

			newId: function () {
				sequence++;

				return "group-observation-" +
					String(sequence).padStart(12, "0");
			},

			resolveExecutor: function (executor) {
				var specification = specifications.find(function (item) {
					return executor === "group-observation-" + item.name;
				});

				return specification && available[specification.name]
					? handlers[executor]
					: undefined;
			}
		});
	}

	function journals() {
		var result = [];

		wiki.each(function (tiddler, title) {
			if (
				tiddler.fields["clerus-wal-kind"] === "continuation"
			) {
				result.push({
					title: title,
					fields: tiddler.fields,
					record: JSON.parse(tiddler.fields.text)
				});
			}
		});

		return result.sort(function (left, right) {
			return left.title < right.title ? -1 :
				left.title > right.title ? 1 : 0;
		});
	}

	write("initial");

	return {
		wiki: wiki,
		platform: platform,
		titles: titles,
		calls: calls,
		available: available,
		runtime: restart(),
		restart: restart,
		write: write,
		journals: journals,

		count: function (name) {
			return calls.filter(function (call) {
				return call.name === name;
			}).length;
		}
	};
}

function testPersistentBatchContinuesAfterReactionFailure(tw) {
	var f = groupFixture(tw, [
		{ name: "a-failing", persistent: true, fail: true },
		{ name: "b-successful", persistent: true }
	]);

	f.runtime.observe();
	f.write("changed");
	f.runtime.observe();

	assert(f.count("a-failing") === 1);
	assert(f.count("b-successful") === 1);
	assert(f.calls[0].name === "a-failing");
	assert(f.calls[1].name === "b-successful");

	var journals = f.journals();

	assert(journals.length === 1);

	var journal = journals[0];
	var record = journal.record;
	var ids = Object.keys(record.events);

	assert(record.work === null);
	assert(ids.length === 1);
	assert(record.events[ids[0]].mode === "paused");
	assert(
		record.events[ids[0]].event.recipient.title ===
			f.titles["a-failing"]
	);
	assert(
		journal.fields["clerus-custody"] === "user"
	);

	/*
	Both original notifications belonged to the same WAL.
	The successful event has gone, but its identity remains.
	*/
	assert(Object.keys(record.evidence.identities).length === 2);

	assert(
		f.wiki.getTiddler(f.titles["a-failing"])
			.fields["clerus-suspended"] === "yes"
	);

	var successful = JSON.parse(
		f.wiki.getTiddlerText(f.titles["b-successful"])
	);

	assert(successful.charter.status.count === 1);
	assert(successful.charter.status.text === "changed");

	var view = f.runtime.inspect();

	assert(view.obligations.waiting.notifications.ready === 0);
	assert(view.obligations.waiting.notifications.paused === 1);
	assert(view.retention.retained.some(function (entry) {
		return entry.title === f.titles["a-failing"] &&
			entry.reasons.some(function (reason) {
				return reason.kind === "waiting-event";
			});
	}));

	/*
	Neither ordinary servicing nor another observation pass
	retries the paused event or repeats the successful one.
	*/
	f.runtime.recover();
	f.runtime.drainFlows();
	f.runtime.observe();

	assert(f.count("a-failing") === 1);
	assert(f.count("b-successful") === 1);
	assert(
		f.runtime.inspect().observation.pendingRegistration === null
	);
}

function testMixedBatchSurvivesEphemeralReactionFailure(tw) {
	var f = groupFixture(tw, [
		{ name: "a-ephemeral", persistent: false, fail: true },
		{ name: "b-persistent", persistent: true }
	]);

	f.runtime.observe();
	f.write("changed");

	var passes = f.runtime.observe();

	assert(f.count("a-ephemeral") === 1);
	assert(f.count("b-persistent") === 1);

	assert(passes.some(function (pass) {
		return Array.isArray(pass.errors) &&
			pass.errors.some(function (error) {
				return error.title === f.titles["a-ephemeral"] &&
					error.phase === "reaction";
			});
	}));

	assert(
		f.wiki.getTiddler(f.titles["a-ephemeral"])
			.fields["clerus-custody"] === "user"
	);

	var persistent = JSON.parse(
		f.wiki.getTiddlerText(f.titles["b-persistent"])
	);

	assert(persistent.charter.status.count === 1);
	assert(persistent.charter.status.text === "changed");
	assert(f.journals().length === 0);
	assert(
		f.runtime.inspect().observation.pendingRegistration === null
	);

	f.runtime.observe();
	f.runtime.recover();
	f.runtime.drainFlows();

	assert(f.count("a-ephemeral") === 1);
	assert(f.count("b-persistent") === 1);
}

function testInterruptedMixedBatchRecoversRegisteredNotification(tw) {
	var f = groupFixture(tw, [
		{ name: "a-ephemeral", persistent: false },
		{ name: "b-unavailable", persistent: false },
		{ name: "c-persistent", persistent: true }
	]);

	f.runtime.observe();
	f.write("changed");

	f.available["b-unavailable"] = false;

	var error = throws(function () {
		f.runtime.observe();
	});

	assert(
		String(error.message).indexOf(
			"Recipient executor is unavailable"
		) !== -1
	);

	assert(f.count("a-ephemeral") === 1);
	assert(f.count("b-unavailable") === 0);
	assert(f.count("c-persistent") === 0);

	/*
	The baseline is committed and the observation stage is closed,
	but the accepted persistent registration survives.
	*/
	assert(
		f.runtime.inspect().observation.pendingRegistration === null
	);
	assert(!f.runtime.executing);
	assert(!f.runtime.observing);

	var journals = f.journals();

	assert(journals.length === 1);

	var journal = journals[0];
	var record = journal.record;

	assert(record.work !== null);
	assert(record.work.emits.length === 1);
	assert(Object.keys(record.events).length === 0);
	assert(
		record.work.emits[0].event.recipient.title ===
			f.titles["c-persistent"]
	);

	var eventId = record.work.emits[0].id;
	var journalTitle = journal.title;

	/*
	Another observation pass must not register the same change
	again, even after the missing executor becomes available.
	*/
	f.available["b-unavailable"] = true;
	f.runtime.observe();

	journals = f.journals();

	assert(journals.length === 1);
	assert(journals[0].title === journalTitle);
	assert(journals[0].record.work.emits[0].id === eventId);
	assert(f.count("a-ephemeral") === 1);
	assert(f.count("b-unavailable") === 0);
	assert(f.count("c-persistent") === 0);

	/*
	A fresh runtime continues the authoritative work.
	It does not need the previous observer's ephemeral history.
	*/
	var restarted = f.restart();

	restarted.recover();
	restarted.drainFlows();

	assert(f.count("c-persistent") === 1);

	var delivered = f.calls.filter(function (call) {
		return call.name === "c-persistent";
	});

	assert(delivered[0].id === eventId);
	assert(f.journals().length === 0);

	restarted.observe();
	restarted.recover();
	restarted.drainFlows();

	assert(f.count("a-ephemeral") === 1);
	assert(f.count("b-unavailable") === 0);
	assert(f.count("c-persistent") === 1);
}

function movingObserverFixture(tw) {
	var sourcePlatform = tw.browser ? "browser" : "node";
	var destinationPlatform =
		sourcePlatform === "browser" ? "node" : "browser";
	var title = "$:/clerus/jobs/moving-observer";
	var target = "Moving Observer Document";
	var sequence = 0;
	var calls = [];
	var modes = {};

	function nextId() {
		sequence++;

		return "moving-observer-" +
			String(sequence).padStart(12, "0");
	}

	function side(platform) {
		var wiki = new tw.Wiki();

		modes[platform] = "read";

		var runtime = new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: nextId,

			resolveExecutor: function (executor) {
				if (executor !== "moving-observer-test") {
					return undefined;
				}

				return function (event, operational) {
					if (
						event.type === "suspended" ||
						event.type === "resumed"
					) {
						return;
					}

					assert(event.type === "document-change");

					calls.push({
						platform: platform,
						id: event.id,
						keys: event.keys.slice(),
						text: operational.get(event.keys[0]).text()
					});

					if (modes[platform] === "write") {
						operational.get("charter").setStatus({
							writtenBy: platform
						});
					}
				};
			}
		});

		function write(text) {
			wiki.addTiddler(new tw.Tiddler({
				title: target,
				text: text
			}));
		}

		write("initial");

		return {
			wiki: wiki,
			runtime: runtime,
			platform: platform,
			write: write
		};
	}

	var source = side(sourcePlatform);
	var destination = side(destinationPlatform);

	source.wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": sourcePlatform,
		"clerus-executor": "moving-observer-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			document: target
		})
	}));

	function move() {
		var journal = "$:/clerus/wal/" + sourcePlatform +
			"/moving-observer-transfer";
		var workId = "moving-observer-transfer-work-0001";
		var before = source.runtime.store.read(title).fields;

		assert(source.runtime.custody.owns(before));

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

		source.wiki.addTiddler(new tw.Tiddler({
			title: journal,
			type: "application/json",
			"clerus-custody": sourcePlatform,
			"clerus-wal-kind": "continuation",
			text: JSON.stringify({
				version: 2,
				kind: "continuation",
				platform: sourcePlatform,
				work: {
					version: 2,
					id: workId,
					checks: [],
					transitions: [
						stores.transition(title, before, after)
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

		var report = source.runtime.recover();

		assert(report.entries.some(function (entry) {
			return entry.title === journal &&
				entry.status === "completed";
		}));

		assert(!source.wiki.tiddlerExists(journal));
		assert(!source.runtime.custody.owns(
			source.runtime.store.read(title).fields
		));

		destination.wiki.addTiddler(new tw.Tiddler(
			source.wiki.getTiddler(title)
		));

		assert(!destination.runtime.custody.owns(
			destination.runtime.store.read(title).fields
		));

		return journal;
	}

	/*
	A user-authored continuation is a legitimate source of work.
	Keep it under user custody until the relocation completes.
	*/
	function heldNotification() {
		var eventId = nextId();
		var journal = "$:/clerus/wal/" + sourcePlatform +
			"/moving-observer-notification";

		source.wiki.addTiddler(new tw.Tiddler({
			title: journal,
			type: "application/json",
			"clerus-custody": "user",
			"clerus-wal-kind": "continuation",
			text: JSON.stringify({
				version: 2,
				kind: "continuation",
				platform: sourcePlatform,
				work: {
					version: 2,
					id: nextId(),
					checks: [],
					transitions: [],
					blocks: [],
					emits: [{
						id: eventId,
						event: {
							kind: "notification",
							recipient: {
								title: title,
								executor: "moving-observer-test"
							},
							notification: {
								type: "document-change",
								target: target,
								keys: ["document"]
							}
						}
					}]
				},
				events: {},
				evidence: {
					identities: {},
					receipts: {}
				},
				diagnostics: []
			})
		}));

		return {
			title: journal,
			id: eventId,

			release: function () {
				source.wiki.addTiddler(new tw.Tiddler(
					source.wiki.getTiddler(journal),
					{ "clerus-custody": sourcePlatform }
				));

				source.runtime.recover();
				return source.runtime.drainFlows();
			}
		};
	}

	return {
		source: source,
		destination: destination,
		title: title,
		target: target,
		calls: calls,
		modes: modes,
		move: move,
		heldNotification: heldNotification
	};
}

function testObservationWaitsForDestinationCustody(tw) {
	var f = movingObserverFixture(tw);

	f.source.runtime.observe();

	var transferJournal = f.move();

	/*
	The destination sees the job, but has no deletion evidence.
	Neither side may register a new notification now.
	*/
	f.source.write("during transfer");
	f.destination.write("during transfer");

	assert(f.source.runtime.observe().length === 0);
	assert(f.destination.runtime.observe().length === 0);
	assert(f.calls.length === 0);

	f.destination.runtime.recordWalDeletion(transferJournal);

	assert(f.destination.runtime.custody.owns(
		f.destination.runtime.store.read(f.title).fields
	));

	/*
	Entry establishes a local baseline, not a notification about
	changes that happened before this runtime acquired custody.
	*/
	assert(f.destination.runtime.observe().length === 0);
	assert(f.calls.length === 0);

	f.source.write("after transfer");
	f.destination.write("after transfer");

	assert(f.source.runtime.observe().length === 0);
	f.destination.runtime.observe();

	assert(f.calls.length === 1);
	assert(
		f.calls[0].platform === f.destination.platform
	);
	assert(f.calls[0].text === "after transfer");

	f.source.runtime.observe();
	f.destination.runtime.observe();

	assert(f.calls.length === 1);
}

function testOldNotificationRemainsAtSourceAfterMove(tw) {
	var f = movingObserverFixture(tw);
	var notification = f.heldNotification();
	var transferJournal = f.move();

	f.destination.runtime.recordWalDeletion(transferJournal);

	/*
	Model a newer synchronized operational snapshot.
	Do not modify the registered notification.
	*/
	var registry = JSON.parse(
		f.destination.wiki.getTiddlerText(f.title)
	);

	registry.renamed = registry.document;
	delete registry.document;

	f.destination.wiki.addTiddler(new tw.Tiddler(
		f.destination.wiki.getTiddler(f.title),
		{ text: JSON.stringify(registry) }
	));

	f.source.wiki.addTiddler(new tw.Tiddler(
		f.destination.wiki.getTiddler(f.title)
	));

	f.source.write("source-local current view");

	assert(!f.source.runtime.custody.owns(
		f.source.runtime.store.read(f.title).fields
	));

	notification.release();

	assert(f.calls.length === 1);
	assert(f.calls[0].platform === f.source.platform);
	assert(f.calls[0].id === notification.id);
	assert(f.calls[0].keys.join(",") === "renamed");
	assert(f.calls[0].text === "source-local current view");

	assert(!f.source.wiki.tiddlerExists(notification.title));

	var current = f.source.wiki.getTiddler(f.title);

	assert(
		current.fields["clerus-custody"] ===
			f.destination.platform
	);
	assert(current.fields["clerus-suspended"] !== "yes");
	assert(
		JSON.parse(current.fields.text)
			.charter.status.phase === "initial"
	);

	f.source.runtime.recover();
	f.source.runtime.drainFlows();

	assert(f.calls.length === 1);
}

function testOldNotificationCannotWriteMovedRegistry(tw) {
	var f = movingObserverFixture(tw);
	var notification = f.heldNotification();
	var transferJournal = f.move();

	f.destination.runtime.recordWalDeletion(transferJournal);

	f.modes[f.source.platform] = "write";

	var originalText = f.source.wiki.getTiddlerText(f.title);

	notification.release();

	assert(f.calls.length === 1);
	assert(f.calls[0].id === notification.id);

	var current = f.source.wiki.getTiddler(f.title);

	assert(current.fields.text === originalText);
	assert(
		current.fields["clerus-custody"] ===
			f.destination.platform
	);
	assert(current.fields["clerus-suspended"] !== "yes");

	var journal = f.source.wiki.getTiddler(notification.title);

	assert(journal);
	assert(journal.fields["clerus-custody"] === "user");

	var record = JSON.parse(journal.fields.text);

	assert(record.work === null);
	assert(record.events[notification.id].mode === "paused");
	assert(record.diagnostics.some(function (diagnostic) {
		return diagnostic.event === notification.id &&
			diagnostic.phase === "reaction";
	}));

	/*
	Failure on the non-owning platform does not affect the
	destination's authority.
	*/
	assert(f.destination.runtime.custody.owns(
		f.destination.runtime.store.read(f.title).fields
	));
	assert(
		f.destination.wiki.getTiddler(f.title)
			.fields["clerus-suspended"] !== "yes"
	);

	f.source.runtime.recover();
	f.source.runtime.drainFlows();

	assert(f.calls.length === 1);
}

function interruptRecordedObservation(f) {
	f.runtime.observe();
	f.write("changed");

	var originalApply = f.runtime.store.apply;
	var injected = false;
	var eventId = null;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (!injected && f.isRegistration(effect)) {
			injected = true;
			eventId = JSON.parse(effect.after.text)
				.work.emits[0].id;

			throw new Error("Interrupted after observation registration");
		}

		return result;
	};

	try {
		var error = throws(function () {
			f.runtime.observe();
		});

		assert(error.acceptanceUncertain);
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(f.calls.length === 0);

	var pending = f.runtime.observationStatus()
		.pendingRegistration;

	assert(pending);
	assert(pending.uncertain);
	assert(pending.journal);

	return {
		journal: pending.journal,
		eventId: eventId
	};
}

function testRegistrationConfirmedByPublishedFingerprints(tw) {
	var f = fixture(tw);
	var interrupted = interruptRecordedObservation(f);

	f.runtime.recover();

	assert(f.calls.length === 0);

	var record = JSON.parse(
		f.wiki.getTiddlerText(interrupted.journal)
	);

	assert(record.work === null);
	assert(
		record.events[interrupted.eventId].mode === "ready"
	);

	var allocated = f.identitiesAllocated();
	var before = f.wiki.getTiddlerText(interrupted.journal);

	var diagnostic = f.runtime.observationStatus()
		.pendingRegistration;

	assert(diagnostic.uncertain);
	assert(!diagnostic.registered);
	assert(diagnostic.evidence.confirmed);
	assert(
		diagnostic.evidence.source === "event-fingerprints"
	);
	assert(f.identitiesAllocated() === allocated);
	assert(f.calls.length === 0);
	assert(
		f.wiki.getTiddlerText(interrupted.journal) === before
	);

	f.runtime.observe();

	assert(f.calls.length === 1);
	assert(f.calls[0] === interrupted.eventId);
	assert(
		f.runtime.observationStatus().pendingRegistration === null
	);

	f.runtime.observe();

	assert(f.calls.length === 1);
}

function testInvalidRegistrationEvidencePreservesPendingStage(tw) {
	var f = fixture(tw);
	var interrupted = interruptRecordedObservation(f);

	var original = f.wiki.getTiddler(interrupted.journal);
	var allocated = f.identitiesAllocated();

	f.wiki.addTiddler(new tw.Tiddler(original, {
		text: "{broken"
	}));

	var diagnostic = f.runtime.observationStatus()
		.pendingRegistration;

	assert(diagnostic.uncertain);
	assert(!diagnostic.evidence.confirmed);
	assert(diagnostic.evidence.reason === "journal-invalid");

	var error = throws(function () {
		f.runtime.observe();
	});

	assert(error.acceptanceUncertain);
	assert(error.obligationTitle === interrupted.journal);
	assert(f.identitiesAllocated() === allocated);
	assert(f.calls.length === 0);
	assert(
		f.wiki.getTiddlerText(interrupted.journal) === "{broken"
	);

	throws(function () {
		f.runtime.resetObservation();
	});

	/*
	Restore the exact original registration, not a new execution.
	*/
	f.wiki.addTiddler(new tw.Tiddler(original));

	f.runtime.observe();

	assert(f.calls.length === 1);
	assert(f.calls[0] === interrupted.eventId);
	assert(
		f.runtime.observationStatus().pendingRegistration === null
	);
}

function testEvidenceReadFailureDoesNotResolveRegistration(tw) {
	var f = fixture(tw);
	var interrupted = interruptRecordedObservation(f);

	var originalRead = f.runtime.store.read;
	var allocated = f.identitiesAllocated();
	var before = f.wiki.getTiddlerText(interrupted.journal);

	f.runtime.store.read = function (title) {
		if (title === interrupted.journal) {
			throw new Error("Observation evidence storage unavailable");
		}

		return originalRead.call(this, title);
	};

	try {
		var diagnostic = f.runtime.observationStatus()
			.pendingRegistration;

		assert(diagnostic.uncertain);
		assert(!diagnostic.registered);
		assert(!diagnostic.evidence.confirmed);
		assert(
			diagnostic.evidence.reason === "evidence-read-failed"
		);
		assert(diagnostic.evidence.error);
		assert(
			diagnostic.evidence.error.message.indexOf(
				"Observation evidence storage unavailable"
			) !== -1
		);

		var error = throws(function () {
			f.runtime.observe();
		});

		assert(
			String(error.message).indexOf(
				"Observation evidence storage unavailable"
			) !== -1
		);

		assert(f.identitiesAllocated() === allocated);
		assert(f.calls.length === 0);
		assert(
			f.wiki.getTiddlerText(interrupted.journal) === before
		);
		assert(!f.runtime.executing);
		assert(!f.runtime.observing);
	} finally {
		f.runtime.store.read = originalRead;
	}

	var pending = f.runtime.observationStatus()
		.pendingRegistration;

	assert(pending.uncertain);
	assert(!pending.registered);
	assert(pending.evidence.confirmed);
	assert(pending.evidence.source === "accepted-work");

	f.runtime.observe();

	assert(f.calls.length === 1);
	assert(f.calls[0] === interrupted.eventId);
	assert(
		f.runtime.observationStatus().pendingRegistration === null
	);
}

exports.run = function (tw) {
	var cases = [
		["persistent observation: changes become durable notifications", testPersistentObservation],
		["persistent observation: uncertain recorded registration is confirmed", testUncertainRecordedRegistrationIsConfirmed],
		["persistent observation: uncertainty does not create another batch", testUncertainAbsenceDoesNotCreateAnotherBatch],
		["persistent observation: another recipient progresses after reaction failure", testPersistentBatchContinuesAfterReactionFailure],
		["persistent observation: mixed batch survives ephemeral reaction failure", testMixedBatchSurvivesEphemeralReactionFailure],
		["persistent observation: interrupted mixed batch preserves registered notification", testInterruptedMixedBatchRecoversRegisteredNotification],
		["persistent observation: destination waits for effective custody", testObservationWaitsForDestinationCustody],
		["persistent observation: old notification stays at source after relocation", testOldNotificationRemainsAtSourceAfterMove],
		["persistent observation: old notification cannot write moved registry", testOldNotificationCannotWriteMovedRegistry],
		["persistent observation: published fingerprints confirm registration", testRegistrationConfirmedByPublishedFingerprints],
		["persistent observation: invalid evidence preserves pending registration", testInvalidRegistrationEvidencePreservesPendingStage],
		["persistent observation: evidence read failure does not resolve registration", testEvidenceReadFailureDoesNotResolveRegistration]
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