/*\
title: $:/plugins/clerus/core/tests/automatic-collection.js
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

function environment(tw, autoCollectJobs, handlers) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var sequence = 0;

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		autoCollectJobs: autoCollectJobs,

		newId: function () {
			sequence++;

			return "automatic-collection-" +
				String(sequence).padStart(10, "0");
		},

		resolveExecutor: function (name) {
			return handlers[name];
		}
	});

	return {
		wiki: wiki,
		platform: platform,
		runtime: runtime,

		write: function (title, executor, extra) {
			wiki.addTiddler(new tw.Tiddler({
				title: title,
				type: "application/json",
				"clerus-custody": platform,
				"clerus-executor": executor,

				text: JSON.stringify(Object.assign({
					charter: {
						form: "charter",
						status: {}
					}
				}, extra || {}))
			}));
		}
	};
}

function testDisabledByDefault(tw) {
	var title = "$:/clerus/jobs/auto-default-owner";

	var f = environment(tw, undefined, {
		owner: function () {}
	});

	f.write(title, "owner");

	var result = f.runtime.dispatch(
		title,
		{ type: "test" }
	);

	assert(result.status === "completed");
	assert(f.wiki.getTiddler(title));
	assert(f.runtime.inspect().collection === null);
}

function testCollectionWaitsForWholeFlow(tw) {
	var source = "$:/clerus/jobs/auto-flow-source";
	var target = "$:/clerus/jobs/auto-flow-target";
	var received = false;
	var f;

	f = environment(tw, true, {
		source: function (event, operational) {
			var outgoing = operational.outgoing();

			operational.copy("note", outgoing, "input");
			operational.get("target").order(outgoing);
		},

		target: function (event, operational, incoming) {
			assert(f.wiki.getTiddler(source));

			incoming.move("input", operational, "received");
			received = true;
		}
	});

	f.write(source, "source", {
		target: target,
		note: { form: "memo", data: 42 }
	});

	f.write(target, "target");

	var result = f.runtime.dispatch(
		source,
		{ type: "test" }
	);

	assert(result.status === "completed");
	assert(result.flow.errors.length === 0);
	assert(received);

	// One collection pass deletes the unretained superior.
	assert(!f.wiki.getTiddler(source));
	assert(f.wiki.getTiddler(target));

	var first = f.runtime.inspect().collection;

	assert(first.removed.join(",") === source);

	// The newly released target is considered at the next boundary.
	f.runtime.drainFlows();

	assert(!f.wiki.getTiddler(target));
	assert(
		f.runtime.inspect().collection.removed.join(",") === target
	);
}

function testCollectionWaitsForWholeDeferredBatch(tw) {
	var f;
	var ticks = [];
	var first;
	var second;

	function tickHandler(event, operational) {
		if (event.type === "schedule") {
			operational.get("charter").defer();
			return;
		}

		assert(event.type === "tick");

		/*
			Both jobs must remain materialized throughout
			the selected batch.
		*/
		assert(f.wiki.getTiddler(first));
		assert(f.wiki.getTiddler(second));

		ticks.push(event.title);
	}

	f = environment(tw, true, {
		first: tickHandler,
		second: tickHandler
	});

	var prefix = "$:/temp/clerus/jobs/" + f.platform + "/";

	first = prefix + "auto-first-tick";
	second = prefix + "auto-second-tick";

	f.write(first, "first");
	f.write(second, "second");

	f.runtime.dispatch(first, { type: "schedule" });
	f.runtime.dispatch(second, { type: "schedule" });

	assert(f.wiki.getTiddler(first));
	assert(f.wiki.getTiddler(second));

	assert(
		f.runtime.inspect().collection.blocked.includes(
			"ephemeral-ticks-pending"
		)
	);

	var report = f.runtime.runDeferred();

	assert(report.delivered.length === 2);
	assert(ticks.length === 2);

	assert(!f.wiki.getTiddler(first));
	assert(!f.wiki.getTiddler(second));

	var collected = f.runtime.inspect().collection;

	assert(collected.removed.length === 2);
	assert(f.runtime.passDepth === 0);
}

function testRecoveryDoesNotTriggerCollection(tw) {
	var title = "$:/clerus/jobs/auto-recovery-owner";

	var f = environment(tw, true, {
		owner: function () {}
	});

	f.write(title, "owner");

	var report = f.runtime.recover();

	assert(report.entries.length === 0);
	assert(f.wiki.getTiddler(title));
	assert(f.runtime.inspect().collection === null);
	assert(f.runtime.passDepth === 0);
}

function testObservationCollectsOnlyAfterItsBatch(tw) {
	var f;
    var first;
    var second;

	var observed = [];

	function react(event) {
		assert(event.type === "document-change");

		assert(f.wiki.getTiddler(first));
		assert(f.wiki.getTiddler(second));

		observed.push(event.title);
	}

	f = environment(tw, true, {
		first: react,
		second: react
	});

	var prefix = "$:/temp/clerus/jobs/" + f.platform + "/";

	first = prefix + "auto-observer-first";
	second = prefix + "auto-observer-second";
	var target = "Automatic Collection Observation Target";

	f.write(first, "first", { document: target });
	f.write(second, "second", { document: target });

	/*
		Establish the baseline without an external runtime boundary:
		an empty observe() with automatic collection would legally
		collect these otherwise unretained jobs.
	*/
	f.runtime.observer.collect({
		store: f.runtime.store,
		platform: f.platform,
		titles: [first, second]
	});

	f.wiki.addTiddler(new tw.Tiddler({
		title: target,
		text: "changed"
	}));

	var passes = f.runtime.observe();

	assert(passes.length === 2);
	assert(observed.length === 2);

	assert(!f.wiki.getTiddler(first));
	assert(!f.wiki.getTiddler(second));
}

exports.run = function (tw) {
	var cases = [
		["automatic collection: disabled by default", testDisabledByDefault],
		["automatic collection: waits for the whole flow", testCollectionWaitsForWholeFlow],
		["automatic collection: waits for the whole deferred batch", testCollectionWaitsForWholeDeferredBatch],
		["automatic collection: recovery is not a collection boundary", testRecoveryDoesNotTriggerCollection],
		["automatic collection: observation batch remains intact", testObservationCollectsOnlyAfterItsBatch]
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