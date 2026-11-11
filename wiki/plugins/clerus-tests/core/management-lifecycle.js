/*\
title: $:/plugins/clerus/tests/core/management-lifecycle.js
type: application/javascript
module-type: library
\*/

"use strict";

var management = require("$:/plugins/clerus/core/management.js");
var stores = require("$:/plugins/clerus/core/store.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function timerQueue() {
	var sequence = 0;
	var pending = new Map();
	var callbacks = [];

	return {
		set: function (callback) {
			sequence++;
			pending.set(sequence, callback);
			callbacks.push(callback);
			return sequence;
		},

		clear: function (handle) {
			pending.delete(handle);
		},

		count: function () {
			return pending.size;
		},

		replayCallbacks: function () {
			/*
			Simulate callbacks that were already delivered by
			the environment when cancellation occurred.
			*/
			callbacks.slice().forEach(function (callback) {
				callback();
			});
		}
	};
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var automatic = timerQueue();
	var cleanup = timerQueue();
	var listeners = [];
	var sequence = 0;

	// Only subscriptions owned by this isolated adapter are tracked.
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
		platform: tw.browser ? "browser" : "node",
		prototypeWalReceipts: true,

		now: function () {
			return 1000000;
		},

		newId: function () {
			sequence++;

			return "management-lifecycle-" +
				String(sequence).padStart(12, "0");
		},

		setTimer: automatic.set,
		clearTimer: automatic.clear,
		setCleanupTimer: cleanup.set,
		clearCleanupTimer: cleanup.clear
	});

	return {
		wiki: wiki,
		adapter: adapter,
		automatic: automatic,
		cleanup: cleanup,

		listenerCount: function () {
			return listeners.length;
		},

		snapshot: function () {
			var values = [];

			wiki.each(function (tiddler) {
				values.push(stores.capture(tiddler));
			});

			values.sort(function (left, right) {
				return left.title < right.title ? -1
					: left.title > right.title ? 1 : 0;
			});

			return JSON.stringify(values);
		}
	};
}

function testDisposeCancelsBothDrivers(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();
		f.adapter.start();

		assert(f.listenerCount() === 1);
		assert(f.cleanup.count() === 1);
		assert(f.automatic.count() === 0);

		f.adapter.command("automatic-start");

		assert(f.automatic.count() === 1);

		f.adapter.dispose();

		assert(f.listenerCount() === 0);
		assert(f.cleanup.count() === 0);
		assert(f.automatic.count() === 0);

		f.adapter.dispose();
		f.adapter.start();

		assert(f.listenerCount() === 0);
		assert(f.cleanup.count() === 0);
		assert(f.automatic.count() === 0);
	} finally {
		f.adapter.dispose();
	}
}

function testLateCallbacksHaveNoEffects(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();
		f.adapter.command("automatic-start");
		f.adapter.dispose();

		var before = f.snapshot();

		f.automatic.replayCallbacks();
		f.cleanup.replayCallbacks();

		assert(f.snapshot() === before);
		assert(f.automatic.count() === 0);
		assert(f.cleanup.count() === 0);
		assert(f.listenerCount() === 0);
	} finally {
		f.adapter.dispose();
	}
}

function testReportingFailureDoesNotKeepAdapterAlive(tw) {
	var f = fixture(tw);
	var originalAdd = f.wiki.addTiddler;

	try {
		f.adapter.start();
		f.adapter.command("automatic-start");

		f.wiki.addTiddler = function (tiddler) {
			if (
				tiddler.fields.title ===
					f.adapter.automaticStateTitle
			) {
				throw new Error("Automatic status storage unavailable");
			}

			return originalAdd.apply(this, arguments);
		};

		var failed = false;

		try {
			f.adapter.dispose();
		} catch (error) {
			failed = true;
		}

		assert(failed);
		assert(f.listenerCount() === 0);
		assert(f.automatic.count() === 0);
		assert(f.cleanup.count() === 0);

		// Idempotent disposal does not retry the failed status write.
		f.adapter.dispose();

		var rejected = false;

		try {
			f.adapter.command("inspect");
		} catch (error) {
			rejected =
				String(error.message).indexOf("disposed") !== -1;
		}

		assert(rejected);
	} finally {
		f.wiki.addTiddler = originalAdd;
		f.adapter.dispose();
	}
}

exports.run = function (tw) {
	var cases = [
		["management lifecycle: disposal cancels both drivers", testDisposeCancelsBothDrivers],
		["management lifecycle: late callbacks have no effects", testLateCallbacksHaveNoEffects],
		["management lifecycle: reporting failure does not keep adapter alive", testReportingFailureDoesNotKeepAdapterAlive]
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