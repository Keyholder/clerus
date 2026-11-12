/*\
title: $:/plugins/clerus/tests/core/persistent-observation.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;

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

exports.run = function (tw) {
	var cases = [
		["persistent observation: changes become durable notifications", testPersistentObservation],
		["persistent observation: uncertain recorded registration is confirmed", testUncertainRecordedRegistrationIsConfirmed],
		["persistent observation: uncertainty does not create another batch", testUncertainAbsenceDoesNotCreateAnotherBatch],
		["persistent observation: another recipient progresses after reaction failure", testPersistentBatchContinuesAfterReactionFailure],
		["persistent observation: mixed batch survives ephemeral reaction failure", testMixedBatchSurvivesEphemeralReactionFailure],
		["persistent observation: interrupted mixed batch preserves registered notification", testInterruptedMixedBatchRecoversRegisteredNotification]
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