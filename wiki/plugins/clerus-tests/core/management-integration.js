/*\
title: $:/plugins/clerus/tests/core/management-integration.js
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

function delay() {
	return new Promise(function (resolve) {
		setTimeout(resolve, 0);
	});
}

async function settle() {
	/*
	Allow wiki change delivery, scheduled service and notifications
	about that service to pass through separate event-loop turns.
	*/
	for (var index = 0; index < 8; index++) {
		await delay();
	}
}

async function waitFor(predicate, description) {
	var deadline = Date.now() + 3000;

	while (!predicate()) {
		if (Date.now() >= deadline) {
			throw new Error("Timed out: " + description);
		}

		await delay();
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var sequence = 0;
	var serviceReports = 0;
	var notifications = 0;
	var reportTitle = "$:/temp/clerus/management/" + platform;

	var originalAddTiddler = wiki.addTiddler;

	/*
	Count actual service completions, not merely scheduler requests.
	Do not alter change-event delivery.
	*/
	wiki.addTiddler = function (tiddler) {
		if (tiddler.fields.title === reportTitle) {
			var report = JSON.parse(tiddler.fields.text);

			if (report.command === "service") {
				serviceReports++;
			}
		}

		return originalAddTiddler.apply(this, arguments);
	};

	function countChanges() {
		notifications++;
	}

	wiki.addEventListener("change", countChanges);

	var adapter = management.create({
		tw: tw,
		wiki: wiki,
		platform: platform,

		newId: function () {
			sequence++;

			return "management-integration-" +
				String(sequence).padStart(12, "0");
		},

		prototypeWalReceipts: false
	});

	return {
		wiki: wiki,
		platform: platform,
		adapter: adapter,

		record: function (title) {
			return JSON.parse(wiki.getTiddlerText(title));
		},

		serviceReports: function () {
			return serviceReports;
		},

		notifications: function () {
			return notifications;
		},

		dispose: function () {
			adapter.dispose();
			wiki.removeEventListener("change", countChanges);
			wiki.addTiddler = originalAddTiddler;
		}
	};
}

async function testRealChangeStartsDelivery(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();

		var demo = f.adapter.command("demo");

		// Drain notifications caused by startup and draft creation.
		await settle();

		assert(f.notifications() > 0, "Real wiki change events were not delivered");
		assert(!f.wiki.tiddlerExists(demo.job));

		var before = f.serviceReports();

		/*
		This is an external custody edit, not a management command.
		Only the real wiki change listener can initiate service.
		*/
		f.wiki.addTiddler(new tw.Tiddler(
			f.wiki.getTiddler(demo.journal),
			{ "clerus-custody": f.platform }
		));

		await waitFor(function () {
			return f.wiki.tiddlerExists(demo.job);
		}, "automatic establishment after a real wiki change");

		await settle();

		assert(f.serviceReports() === before + 1);
		assert(
			f.record(demo.job).charter.status.completed === 0,
			"Automatic WAL service must not run deferred activations"
		);

		var journal = f.record(demo.journal);
		var ids = Object.keys(journal.events);

		assert(ids.length === 1);
		assert(journal.events[ids[0]].event.kind === "activation");
	} finally {
		f.dispose();
	}
}

async function testOwnChangesDoNotCauseServiceLoop(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();

		var demo = f.adapter.command("demo");
		f.adapter.command("release", demo.journal);
		f.adapter.command("inspect");

		var before = f.serviceReports();

		await settle();

		assert(f.notifications() > 0);
		assert(
			f.serviceReports() === before,
			"Own delayed notifications caused another service pass"
		);
		assert(
			f.record(f.adapter.reportTitle).command === "inspect"
		);

		f.adapter.command("deferred");

		assert(f.record(demo.job).charter.status.completed === 1);

		before = f.serviceReports();

		await settle();

		assert(
			f.serviceReports() === before,
			"Tick materialization caused another service pass"
		);
		assert(f.record(demo.job).charter.status.completed === 1);

		// An unrelated ordinary write must not service WAL either.
		f.wiki.addTiddler(new tw.Tiddler({
			title: "Management Integration Unrelated",
			text: "changed"
		}));

		await settle();

		assert(f.serviceReports() === before);
	} finally {
		f.dispose();
	}
}

async function testEventListingFilter(tw) {
	var f = fixture(tw);

	try {
		f.adapter.start();

		var demo = f.adapter.command("demo");
		f.adapter.command("release", demo.journal);

		var journal = f.record(demo.journal);
		var expected = Object.keys(journal.events).sort();

		/*
		Use the same filter pipeline as the panel.
		The title is supplied through a filter variable.
		*/
		var widget = {
			getVariable: function (name) {
				return name === "journalTitle"
					? demo.journal
					: undefined;
			}
		};

		var actual = f.wiki.filterTiddlers(
			"[<journalTitle>get[text]jsonindexes[events]]",
			widget
		).sort();

		assert(expected.length === 1);
		assert(
			JSON.stringify(actual) === JSON.stringify(expected),
			"Panel filter does not list the authoritative waiting events"
		);
	} finally {
		f.dispose();
	}
}

exports.run = async function (tw) {
	var cases = [
		[
			"management integration: real change triggers WAL service",
			testRealChangeStartsDelivery
		],
		[
			"management integration: own changes do not cause a service loop",
			testOwnChangesDoNotCauseServiceLoop
		],
		[
			"management integration: panel filter lists waiting events",
			testEventListingFilter
		]
	];

	var results = [];

	for (var index = 0; index < cases.length; index++) {
		var item = cases[index];

		try {
			await item[1](tw);

			results.push({
				name: item[0],
				passed: true,
				error: null
			});
		} catch (error) {
			results.push({
				name: item[0],
				passed: false,
				error: String(error.stack || error)
			});
		}
	}

	return {
		passed: results.every(function (result) {
			return result.passed;
		}),
		results: results
	};
};