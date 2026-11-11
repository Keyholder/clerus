/*\
title: $:/plugins/clerus/tests/core/job-observation.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var observation = require("$:/plugins/clerus/core/observation.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var target = "$:/clerus/jobs/job-observation-target";
	var watcher = "$:/temp/clerus/jobs/" + platform +
		"/job-observation-watcher";
	var sequence = 0;
	var received = [];

	function writeTarget(status) {
		wiki.addTiddler(new tw.Tiddler({
			title: target,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "target",
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: status
				}
			})
		}));
	}

	writeTarget({ phase: "initial", count: 0 });

	wiki.addTiddler(new tw.Tiddler({
		title: watcher,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "watcher",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			first: target,
			second: target
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "job-observation-" +
				String(sequence).padStart(12, "0");
		},

		resolveExecutor: function (name) {
			if (name === "target") {
				return function (event, operational) {
					operational.get("charter").setStatus(event.status);
				};
			}

			if (name === "watcher") {
				return function (event, operational) {
					assert(event.type === "job-status-change");
					assert(Object.isFrozen(event.keys));

					received.push({
						event: event,
						view: operational.get(event.keys[0]).inspect()
					});
				};
			}
		}
	});

	return {
		wiki: wiki,
		platform: platform,
		target: target,
		watcher: watcher,
		runtime: runtime,
		received: received,
		writeTarget: writeTarget
	};
}

function testStatusChangeWaitsForPass(tw) {
	var f = fixture(tw);

	assert(f.runtime.observe().length === 0);

	var result = f.runtime.dispatch(f.target, {
		type: "change",
		status: { phase: "running", count: 1 }
	});

	assert(result.status === "completed");
	assert(f.received.length === 0);

	assert(f.runtime.observe().length === 1);
	assert(f.received.length === 1);
	assert(f.received[0].event.target === f.target);
	assert(f.received[0].event.keys.join(",") === "first,second");
	assert(f.received[0].view.status.phase === "running");
	assert(f.runtime.observe().length === 0);
}

function testUnrelatedFieldsAndKeyOrderDoNotNotify(tw) {
	var f = fixture(tw);

	f.runtime.observe();

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.target),
		{ revision: "changed-transport-revision" }
	));

	assert(f.runtime.observe().length === 0);

	f.writeTarget({ count: 0, phase: "initial" });

	assert(f.runtime.observe().length === 0);
	assert(f.received.length === 0);
}

function testDisappearanceAndRestoration(tw) {
	var f = fixture(tw);

	f.runtime.observe();

	f.wiki.deleteTiddler(f.target);
	f.runtime.observe();

	assert(f.received.length === 1);
	assert(!f.received[0].view.exists);
	assert(!f.received[0].view.readable);

	f.writeTarget({ phase: "restored" });
	f.runtime.observe();

	assert(f.received.length === 2);
	assert(f.received[1].view.readable);
	assert(f.received[1].view.status.phase === "restored");
}

function testRefreshUsesCurrentKeys(tw) {
	var f = fixture(tw);

	f.runtime.observe();
	f.writeTarget({ phase: "changed" });

	var events = f.runtime.observer.collect({
		store: f.runtime.store,
		platform: f.platform,
		titles: [f.watcher],
		readJobs: f.runtime.readJobs
	});

	assert(events.length === 1);

	var tiddler = f.wiki.getTiddler(f.watcher);
	var registry = JSON.parse(tiddler.fields.text);

	registry.renamed = registry.first;
	delete registry.first;
	delete registry.second;

	f.wiki.addTiddler(new tw.Tiddler(tiddler, {
		text: JSON.stringify(registry)
	}));

	var current = observation.refresh(events[0], {
		store: f.runtime.store,
		platform: f.platform
	});

	assert(current.keys.join(",") === "renamed");
	assert(f.received.length === 0);
}

exports.run = function (tw) {
	var cases = [
		["job observation: status changes wait for an observation pass", testStatusChangeWaitsForPass],
		["job observation: unrelated fields and key order do not notify", testUnrelatedFieldsAndKeyOrderDoNotNotify],
		["job observation: disappearance and restoration are observed", testDisappearanceAndRestoration],
		["job observation: refresh uses current document keys", testRefreshUsesCurrentKeys]
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