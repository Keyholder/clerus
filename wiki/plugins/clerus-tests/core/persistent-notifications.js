/*\
title: $:/plugins/clerus/tests/core/persistent-notifications.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var eventSchema = require("$:/plugins/clerus/core/event-schema.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function throws(fn) {
	var caught = false;

	try {
		fn();
	} catch (error) {
		caught = true;
	}

	assert(caught, "Expected an exception");
}

function fixture(tw, handler) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/persistent-notification-target";
	var target = "Persistent Notification Document";
	var journal = "$:/clerus/wal/" + platform + "/notification-test";
	var eventId = "persistent-notification-event-0001";
	var sequence = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "notification-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { count: 0 }
			},
			document: target
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		text: "current"
	}));

	function restart() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,

			newId: function () {
				sequence++;

				return "persistent-notification-" +
					String(sequence).padStart(12, "0");
			},

			resolveExecutor: function () {
				return handler;
			}
		});
	}

	var event = {
		kind: "notification",
		recipient: {
			title: title,
			executor: "notification-test"
		},
		notification: {
			type: "document-change",
			target: target,
			keys: ["document"]
		}
	};

	wiki.addTiddler(new tw.Tiddler({
		title: journal,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-wal-kind": "continuation",
		text: JSON.stringify({
			version: 2,
			kind: "continuation",
			platform: platform,
			work: {
				version: 2,
				id: "persistent-notification-work-0001",
				checks: [],
				transitions: [],
				blocks: [],
				emits: [{
					id: eventId,
					event: event
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
		wiki: wiki,
		platform: platform,
		title: title,
		target: target,
		journal: journal,
		eventId: eventId,
		event: event,
		runtime: restart(),
		restart: restart,

		record: function () {
			return JSON.parse(wiki.getTiddlerText(journal));
		}
	};
}

function testSchema(tw) {
	var f = fixture(tw, function () {});

	assert(eventSchema.validate(f.event).kind === "notification");

	var invalid = JSON.parse(JSON.stringify(f.event));
	invalid.notification.id = "spoofed";

	throws(function () {
		eventSchema.validate(invalid);
	});

	invalid = JSON.parse(JSON.stringify(f.event));
	invalid.notification.keys = ["document", "document"];

	throws(function () {
		eventSchema.validate(invalid);
	});

	invalid = JSON.parse(JSON.stringify(f.event));
	invalid.recipient.title =
		"$:/temp/clerus/jobs/" + f.platform + "/not-supported";

	throws(function () {
		eventSchema.validate(invalid);
	});
}

function testDeliveryAndRetention(tw) {
	var calls = 0;
	var f;

	f = fixture(tw, function (event, operational, incoming) {
		assert(event.type === "document-change");
		assert(event.id === f.eventId);
		assert(event.title === f.title);
		assert(event.platform === f.platform);
		assert(Object.isFrozen(event.keys));
		assert(incoming === null);

		calls++;

		operational.get("charter").setStatus({
			count: calls,
			text: operational.get(event.keys[0]).text()
		});
	});

	var recovered = f.runtime.recover();

	assert(calls === 0);
	assert(recovered.summary.waiting.notifications.ready === 1);
	assert(recovered.summary.waiting.deliveries.ready === 0);
	assert(recovered.summary.waiting.activations.ready === 0);

	var view = f.runtime.inspect();

	assert(view.retention.retained.some(function (entry) {
		return entry.title === f.title &&
			entry.reasons.some(function (reason) {
				return reason.kind === "waiting-event";
			});
	}));

	var result = f.runtime.drainFlows();

	assert(calls === 1);
	assert(result.summary.waiting.notifications.ready === 0);
	assert(!f.wiki.tiddlerExists(f.journal));

	var registry = JSON.parse(f.wiki.getTiddlerText(f.title));

	assert(registry.charter.status.count === 1);
	assert(registry.charter.status.text === "current");
}

function testFailureAndRetry(tw) {
	var fail = true;
	var calls = [];

	var f = fixture(tw, function (event, operational) {
		if (
			event.type === "suspended" ||
			event.type === "resumed"
		) {
			return;
		}

		calls.push(event.id);

		if (fail) {
			throw new Error("Notification handler failed");
		}

		operational.get("charter").setStatus({
			count: 1
		});
	});

	f.runtime.recover();
	f.runtime.drainFlows();

	var record = f.record();

	assert(record.events[f.eventId].mode === "paused");
	assert(
		f.wiki.getTiddler(f.journal)
			.fields["clerus-custody"] === "user"
	);
	assert(
		f.wiki.getTiddler(f.title)
			.fields["clerus-suspended"] === "yes"
	);

	var fingerprint = record.evidence.identities[f.eventId];

	// Repair and resume the recipient independently of its event.
	fail = false;

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.title),
		{ "clerus-custody": f.platform }
	));

	f.runtime.resume(f.title);

	// Administrative retry preserves normative content and identity.
	record = f.record();
	record.events[f.eventId].mode = "ready";

	assert(record.evidence.identities[f.eventId] === fingerprint);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.journal),
		{
			"clerus-custody": f.platform,
			text: JSON.stringify(record)
		}
	));

	f.runtime.recover();
	f.runtime.drainFlows();

	assert(calls.length === 2);
	assert(calls[0] === f.eventId);
	assert(calls[1] === f.eventId);
	assert(!f.wiki.tiddlerExists(f.journal));
}

function testMaterializationDoesNotReplayHandler(tw) {
	var calls = 0;

	var f = fixture(tw, function (event, operational) {
		calls++;

		operational.get("charter").setStatus({
			count: calls
		});
	});

	f.runtime.recover();

	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (!injected && effect.title === f.title) {
			injected = true;
			throw new Error("Interrupted after recipient write");
		}

		return result;
	};

	try {
		f.runtime.drainFlows();
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(calls === 1);

	var record = f.record();

	assert(record.work !== null);
	assert(Object.keys(record.events).length === 0);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.journal),
		{ "clerus-custody": f.platform }
	));

	var restarted = f.restart();

	restarted.recover();
	restarted.drainFlows();

	assert(calls === 1);
	assert(!f.wiki.tiddlerExists(f.journal));
}

function testDeliveryRefreshesKeys(tw) {
	var calls = 0;
	var f;

	f = fixture(tw, function (event, operational) {
		calls++;

		assert(event.id === f.eventId);
		assert(event.title === f.title);
		assert(event.platform === f.platform);
		assert(Object.isFrozen(event));
		assert(Object.isFrozen(event.keys));
		assert(event.keys.length === 1);
		assert(event.keys[0] === "renamed");

		operational.get("charter").setStatus({
			count: calls,
			text: operational.get(event.keys[0]).text()
		});
	});

	f.runtime.recover();

	var before = f.record();
	var fingerprint = before.evidence.identities[f.eventId];

	/*
	The notification retains its original normative content.
	Only the current operational key changes.
	*/
	var registry = JSON.parse(f.wiki.getTiddlerText(f.title));

	registry.renamed = registry.document;
	delete registry.document;

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.title),
		{ text: JSON.stringify(registry) }
	));

	var waiting = f.record();

	assert(
		waiting.events[f.eventId].event.notification.keys[0] ===
			"document"
	);
	assert(
		waiting.evidence.identities[f.eventId] === fingerprint
	);

	f.runtime.drainFlows();

	assert(calls === 1);
	assert(!f.wiki.tiddlerExists(f.journal));

	registry = JSON.parse(f.wiki.getTiddlerText(f.title));

	assert(registry.charter.status.text === "current");
	assert(
		f.wiki.getTiddler(f.title)
			.fields["clerus-suspended"] !== "yes"
	);
}

function testRemovedSubscriptionConsumesNotification(tw) {
	var calls = 0;

	var f = fixture(tw, function () {
		calls++;
		throw new Error("Removed subscription must not invoke handler");
	});

	f.runtime.recover();

	var registry = JSON.parse(f.wiki.getTiddlerText(f.title));

	/*
	Reuse the old key for an unrelated document. A stale event
	must not direct the handler to that document.
	*/
	registry.document = "Unrelated Notification Document";

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.title),
		{ text: JSON.stringify(registry) }
	));

	var result = f.runtime.drainFlows();

	assert(calls === 0);
	assert(!f.wiki.tiddlerExists(f.journal));
	assert(result.summary.waiting.notifications.ready === 0);
	assert(result.summary.waiting.notifications.paused === 0);

	registry = JSON.parse(f.wiki.getTiddlerText(f.title));

	assert(registry.charter.status.count === 0);
	assert(registry.document === "Unrelated Notification Document");
	assert(
		f.wiki.getTiddler(f.title)
			.fields["clerus-custody"] === f.platform
	);
	assert(
		f.wiki.getTiddler(f.title)
			.fields["clerus-suspended"] !== "yes"
	);
}

exports.run = function (tw) {
	var cases = [
		["persistent notifications: strict event schema", testSchema],
		["persistent notifications: delivery and recipient retention", testDeliveryAndRetention],
		["persistent notifications: failure preserves an event for retry", testFailureAndRetry],
		["persistent notifications: materialization recovery does not replay handler", testMaterializationDoesNotReplayHandler],
		["persistent notifications: delivery refreshes document keys", testDeliveryRefreshesKeys],
		["persistent notifications: removed subscription consumes notification without invocation", testRemovedSubscriptionConsumesNotification]
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