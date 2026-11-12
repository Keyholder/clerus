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

exports.run = function (tw) {
	var cases = [
		["persistent observation: changes become durable notifications", testPersistentObservation],
		["persistent observation: uncertain recorded registration is confirmed", testUncertainRecordedRegistrationIsConfirmed],
		["persistent observation: uncertainty does not create another batch", testUncertainAbsenceDoesNotCreateAnotherBatch]
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