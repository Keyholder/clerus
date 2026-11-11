/*\
title: $:/plugins/clerus/tests/core/management-retention.js
type: application/javascript
module-type: library
\*/

"use strict";

var management = require("$:/plugins/clerus/core/management.js");
var retentionView = require(
	"$:/plugins/clerus/core/retention-view.js"
);

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var time = 1000000;
	var sequence = 0;
	var adapters = [];

	function createAdapter() {
		var adapter = management.create({
			tw: tw,
			wiki: wiki,
			platform: platform,
			prototypeWalReceipts: true,

			now: function () {
				return time;
			},

			newId: function () {
				sequence++;

				return "management-retention-" +
					String(sequence).padStart(12, "0");
			}
		});

		adapters.push(adapter);
		return adapter;
	}

	return {
		wiki: wiki,
		platform: platform,
		createAdapter: createAdapter,

		setTime: function (value) {
			time = value;
		},

		record: function (title) {
			assert(wiki.tiddlerExists(title), "Missing tiddler: " + title);
			return JSON.parse(wiki.getTiddlerText(title));
		},

		retention: function () {
			return retentionView.read({
				wiki: wiki,
				Tiddler: tw.Tiddler,
				platform: platform
			});
		},

		dispose: function () {
			adapters.forEach(function (adapter) {
				adapter.dispose();
			});
		}
	};
}

function completeAndClose(f, adapter) {
	var project = adapter.command("project-demo");
	adapter.command("release", project.journal);

	var resources = adapter.command(
		"project-resources",
		project.root
	);

	adapter.command("release", resources.journal);

	var root = f.record(project.root);
	var workers = ["first", "second", "third"].map(function (segment) {
		return root["worker-" + segment];
	});

	adapter.command("deferred");

	assert(
		f.record(project.root).charter.status.phase === "completed"
	);

	var close = adapter.command("project-close", project.root);
	adapter.command("release", close.journal);

	assert(
		f.record(project.root).charter.status.phase === "closed"
	);

	return {
		project: project.project,
		root: project.root,
		workers: workers,
		journals: [
			project.journal,
			resources.journal,
			close.journal
		]
	};
}

function assertEmptyRetained(f, journals, deadline) {
	journals.forEach(function (title) {
		var record = f.record(title);

		assert(record.work === null);
		assert(Object.keys(record.events).length === 0);
		assert(record.diagnostics.length === 0);
		assert(record.retainUntil === deadline);
	});
}

function testRetainedHistoryDoesNotPreventCollection(tw) {
	var f = fixture(tw);

	try {
		var adapter = f.createAdapter();
		adapter.start();

		var project = completeAndClose(f, adapter);

		assertEmptyRetained(f, project.journals, 1150000);

		var view = f.retention();

		assert(view.complete);
		assert(view.valid);

		project.workers.forEach(function (title) {
			var worker = view.jobs.find(function (entry) {
				return entry.title === title;
			});

			assert(worker);
			assert(worker.reasons.length === 0);
			assert(worker.analysisCandidate);
		});

		var rootBefore = f.wiki.getTiddlerText(project.root);
		var treeBefore = f.wiki.getTiddlerText(project.project);

		var collected = adapter.command("collect");

		assert(collected.blocked.length === 0);
		assert(collected.failures.length === 0);
		assert(collected.removed.length === 3);

		project.workers.forEach(function (title) {
			assert(collected.removed.indexOf(title) !== -1);
			assert(!f.wiki.tiddlerExists(title));
		});

		// Historical continuation evidence does not resurrect jobs.
		adapter.command("service");

		assertEmptyRetained(f, project.journals, 1150000);

		assert(f.wiki.getTiddlerText(project.root) === rootBefore);
		assert(f.wiki.getTiddlerText(project.project) === treeBefore);

		f.setTime(1150000);
		adapter.command("service");

		project.journals.forEach(function (title) {
			assert(!f.wiki.tiddlerExists(title));
		});

		assert(f.wiki.getTiddlerText(project.root) === rootBefore);
		assert(f.wiki.getTiddlerText(project.project) === treeBefore);
	} finally {
		f.dispose();
	}
}

function testRestartDoesNotRenewMinimumLifetime(tw) {
	var f = fixture(tw);

	try {
		var first = f.createAdapter();
		first.start();

		var project = completeAndClose(f, first);

		assertEmptyRetained(f, project.journals, 1150000);

		var rootBefore = f.wiki.getTiddlerText(project.root);

		first.dispose();
		f.setTime(1149999);

		var restarted = f.createAdapter();
		restarted.start();

		// Restart services the journals, but does not renew their term.
		assertEmptyRetained(f, project.journals, 1150000);
		assert(f.wiki.getTiddlerText(project.root) === rootBefore);

		f.setTime(1150000);
		restarted.command("service");

		project.journals.forEach(function (title) {
			assert(!f.wiki.tiddlerExists(title));
		});

		assert(f.wiki.getTiddlerText(project.root) === rootBefore);
		assert(
			f.record(project.root).charter.status.phase === "closed"
		);
	} finally {
		f.dispose();
	}
}

exports.run = function (tw) {
	var cases = [
		[
			"management retention: exhausted history does not retain released workers",
			testRetainedHistoryDoesNotPreventCollection
		],
		[
			"management retention: restart does not renew minimum WAL lifetime",
			testRestartDoesNotRenewMinimumLifetime
		]
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