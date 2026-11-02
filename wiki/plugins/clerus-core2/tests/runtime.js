/*\
title: $:/plugins/clerus/core2/tests/runtime.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core2/runtime.js").Runtime;

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw, handler) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title =
		"$:/temp/clerus/jobs/" + platform + "/assembled-runtime";

	var sequence = 0;

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "runtime-test-" +
				String(sequence).padStart(12, "0");
		},

		resolveExecutor: function (name) {
			return name === "runtime-test" ? handler : undefined;
		}
	});

	return {
		wiki: wiki,
		title: title,
		platform: platform,
		runtime: runtime,

		writeJob: function (extra) {
			var registry = {
				charter: {
					form: "charter",
					status: { phase: "initial" }
				}
			};

			Object.keys(extra || {}).forEach(function (key) {
				Object.defineProperty(registry, key, {
					value: extra[key],
					enumerable: true,
					writable: true,
					configurable: true
				});
			});

			wiki.addTiddler(new tw.Tiddler({
				title: title,
				type: "application/json",
				"clerus-custody": platform,
				"clerus-executor": "runtime-test",
				text: JSON.stringify(registry)
			}));
		}
	};
}

function testPersistentIncidentAndUntouchedRegistry(tw) {
	var notifications = 0;

	var f = fixture(tw, function (event) {
		if (event.type === "dismissed") {
			notifications++;
			return;
		}

		throw new Error("Assembled executor failure");
	});

	f.writeJob();

	var before = f.wiki.getTiddler(f.title).fields.text;

	var result = f.runtime.dispatch(
		f.title,
		{ type: "test" }
	);

	assert(result.errors.length === 1);
	assert(notifications === 1);

	var transition = result.errors[0].lifecycle;

	assert(transition.dismissed);
	assert(transition.incident);

	var incident = f.wiki.getTiddler(transition.incident);
	var body = JSON.parse(incident.fields.text);

	assert(incident.fields["clerus-custody"] === "user");
	assert(incident.fields["clerus-wal-kind"] === "incident");
	assert(body.kind === "incident");
	assert(body.incident.owner.title === f.title);
	assert(
		body.incident.error.message ===
			"Assembled executor failure"
	);

	assert(f.wiki.getTiddler(f.title).fields.text === before);
	assert(
		f.wiki.getTiddler(f.title)
			.fields["clerus-custody"] === "user"
	);

	// Service tiddlers must not enter the organizational projection.
	assert(f.runtime.readJobs().length === 1);
}

function testObservationUsesRealReactions(tw) {
	var observed = [];
	var target = "Core2 Assembled Observation Target";

	var f = fixture(tw, function (event, operational) {
		assert(event.type === "document-change");
		assert(event.keys.length === 2);

		var document = operational.get(event.keys[0]);

		observed.push(document.text());

		operational.get("charter").setStatus({
			last: document.text()
		});
	});

	f.writeJob({
		first: target,
		second: target
	});

	assert(f.runtime.observe().length === 0);

	f.wiki.addTiddler(new tw.Tiddler({
		title: target,
		text: "changed"
	}));

	var passes = f.runtime.observe();

	assert(passes.length === 1);
	assert(passes[0].errors.length === 0);
	assert(observed.join(",") === "changed");

	assert(f.runtime.observe().length === 0);

	var registry = JSON.parse(
		f.wiki.getTiddler(f.title).fields.text
	);

	assert(registry.charter.status.last === "changed");
}

function testUnreadableJobRemainsVisible(tw) {
	var f = fixture(tw, function () {});

	f.writeJob();

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.title),
		{ text: "null" }
	));

	var jobs = f.runtime.readJobs();
	var report = f.runtime.inspect();

	assert(jobs.length === 1);
	assert(jobs[0].registry === null);
	assert(!report.hierarchy.complete);
	assert(!report.missions.complete);
}

function testInspectionIsIsolated(tw) {
	var f = fixture(tw, function () {});

	f.writeJob();

	var report = f.runtime.inspect();

	report.jobs[0].registry.charter.status.phase = "local";

	var current = f.runtime.inspect();

	assert(
		current.jobs[0].registry.charter.status.phase === "initial"
	);
}

exports.run = function (tw) {
	var cases = [
		["runtime: incident survives outside the registry", testPersistentIncidentAndUntouchedRegistry],
		["runtime: observation invokes real reactions", testObservationUsesRealReactions],
		["runtime: unreadable job remains in the perspective", testUnreadableJobRemainsVisible],
		["runtime: inspection exposes isolated data", testInspectionIsIsolated]
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