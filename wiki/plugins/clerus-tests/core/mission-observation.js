/*\
title: $:/plugins/clerus/tests/core/mission-observation.js
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
	var director = "$:/clerus/jobs/mission-observation-director";
	var worker = "$:/temp/clerus/jobs/" + platform +
		"/mission-observation-worker";
	var project = "Mission Observation Project";
	var sequence = 0;
	var received = [];

	var mission = {
		form: "mission",
		project: project,
		role: ["item"],
		link: "1/1",
		issued: "0",
		children: {}
	};

	function writeJob(title, executor, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(registry)
		}));
	}

	writeJob(director, "director", {
		charter: { form: "charter", status: {} },
		mission: {
			form: "mission",
			project: project,
			role: [],
			link: "1",
			issued: "1",
			children: { item: "1/1" }
		},
		worker: worker
	});

	writeJob(worker, "worker", {
		charter: { form: "charter", status: {} },
		mission: mission,
		alias: mission
	});

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: {},
			parts: {
				item: {
					task: { value: 42 },
					parts: {}
				}
			}
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "mission-observation-" +
				String(sequence).padStart(12, "0");
		},

		resolveExecutor: function (name) {
			if (name === "director") {
				return function (event, operational) {
					var parent = operational.get("mission");

					if (event.type === "change") {
						parent.setPartTask("item", {
							value: event.value
						});
					} else if (event.type === "remove") {
						parent.removePart("item");
					} else if (event.type === "revoke") {
						parent.revokePart("item");
					} else {
						throw new Error("Unexpected director event");
					}
				};
			}

			if (name === "worker") {
				return function (event, operational) {
					assert(event.type === "mission-change");
					assert(Object.isFrozen(event));
					assert(Object.isFrozen(event.keys));
					assert(Object.isFrozen(event.role));

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
		director: director,
		worker: worker,
		project: project,
		runtime: runtime,
		received: received,

		change: function (value) {
			var result = runtime.dispatch(director, {
				type: "change",
				value: value
			});

			assert(result.status === "completed");
		}
	};
}

function testChangeWaitsForObservation(tw) {
	var f = fixture(tw);

	assert(f.runtime.observe().length === 0);

	f.change(43);

	// Task mutation itself must not invoke the subscriber.
	assert(f.received.length === 0);

	var passes = f.runtime.observe();

	assert(passes.length === 1);
	assert(f.received.length === 1);
	assert(f.received[0].event.keys.join(",") === "alias,mission");
	assert(f.received[0].event.role.join("/") === "item");
	assert(f.received[0].event.project === f.project);
	assert(f.received[0].view.task.value === 43);

	assert(f.runtime.observe().length === 0);
}

function testRemovalAndRevocationAreDifferentChanges(tw) {
	var f = fixture(tw);

	f.runtime.observe();

	assert(
		f.runtime.dispatch(f.director, {
			type: "remove"
		}).status === "completed"
	);

	f.runtime.observe();

	assert(f.received.length === 1);
	assert(f.received[0].view.active);
	assert(!f.received[0].view.readable);

	assert(
		f.runtime.dispatch(f.director, {
			type: "revoke"
		}).status === "completed"
	);

	f.runtime.observe();

	assert(f.received.length === 2);
	assert(!f.received[1].view.active);
	assert(f.runtime.observe().length === 0);
}

function testKeyRenamePreservesSubscription(tw) {
	var f = fixture(tw);

	f.runtime.observe();

	var tiddler = f.wiki.getTiddler(f.worker);
	var registry = JSON.parse(tiddler.fields.text);

	registry.renamed = registry.mission;
	delete registry.mission;
	delete registry.alias;

	f.wiki.addTiddler(new tw.Tiddler(tiddler, {
		text: JSON.stringify(registry)
	}));

	f.change(44);
	f.runtime.observe();

	assert(f.received.length === 1);
	assert(f.received[0].event.keys.join(",") === "renamed");
	assert(f.received[0].view.task.value === 44);
}

function testRefreshSkipsRemovedDocument(tw) {
	var f = fixture(tw);

	f.runtime.observe();
	f.change(45);

	var events = f.runtime.observer.collect({
		store: f.runtime.store,
		platform: f.platform,
		titles: [f.worker],
		readJobs: f.runtime.readJobs
	});

	assert(events.length === 1);

	var tiddler = f.wiki.getTiddler(f.worker);
	var registry = JSON.parse(tiddler.fields.text);

	delete registry.mission;
	delete registry.alias;

	f.wiki.addTiddler(new tw.Tiddler(tiddler, {
		text: JSON.stringify(registry)
	}));

	assert(observation.refresh(events[0], {
		store: f.runtime.store,
		platform: f.platform
	}) === null);

	assert(f.received.length === 0);
}

exports.run = function (tw) {
	var cases = [
		["mission observation: mutation waits for an observation pass", testChangeWaitsForObservation],
		["mission observation: task removal and revocation are distinct", testRemovalAndRevocationAreDifferentChanges],
		["mission observation: renaming keys preserves subscription", testKeyRenamePreservesSubscription],
		["mission observation: refresh skips a removed assignment", testRefreshSkipsRemovedDocument]
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