/*\
title: $:/plugins/clerus/tests/core/continuation-cascade.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var planned = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
var proposalWork = require(
	"$:/plugins/clerus/core/proposal-work.js"
);

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw, settings) {
	settings = settings || {};

	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var titles = {
		root: "$:/clerus/jobs/cascade-root",
		manager: "$:/clerus/jobs/cascade-manager",
		worker: "$:/clerus/jobs/cascade-worker"
	};

	var sequence = 0;
	var trace = [];
	var observedJournals = [];
	var eventIds = [];
	var runtime;

	function write(name, extra) {
		wiki.addTiddler(new tw.Tiddler({
			title: titles[name],
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": name,
			text: JSON.stringify(Object.assign({
				charter: {
					form: "charter",
					status: {}
				}
			}, extra || {}))
		}));
	}

	write("root", {
		subordinate: titles.manager,
		evidence: {
			form: "memo",
			data: 42
		}
	});

	write("manager", {
		subordinate: titles.worker
	});

	write("worker");

	function observeJournal() {
		var found = [];

		wiki.each(function (tiddler, title) {
			var kind = tiddler.fields["clerus-wal-kind"];

			if (kind === "flow" || kind === "continuation") {
				found.push({
					title: title,
					kind: kind,
					record: JSON.parse(tiddler.fields.text)
				});
			}
		});

		assert(found.length === 1);
		assert(found[0].kind === "continuation");
		assert(found[0].record.version === 2);

		observedJournals.push(found[0].title);
	}

	function resolveExecutor(name) {
		return function (event, operational, incoming) {
			if (event.type === "suspended") {
				return;
			}

			trace.push(name);

			if (name === "root") {
				assert(event.type === "test");

				var outgoing = operational.outgoing();

				operational.copy(
					"evidence",
					outgoing,
					"input"
				);

				operational.get("subordinate").order(outgoing);
				return;
			}

			observeJournal();
			eventIds.push(event.id);
			assert(event.type === "order");

			if (name === "manager") {
				if (settings.failManager) {
					throw new Error("Manager rejected event");
				}

				var forwarded = incoming.outgoing();

				incoming.move(
					"input",
					forwarded,
					"input"
				);

				operational.get("subordinate").order(
					forwarded
				);
				return;
			}

			incoming.move("input", operational, "received");
		};
	}

	function createRuntime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: function () {
				sequence++;
				return "cascade-identity-" +
					String(sequence).padStart(12, "0");
			},
			resolveExecutor: resolveExecutor
		});
	}

	runtime = createRuntime();

	return {
		wiki: wiki,
		platform: platform,
		titles: titles,
		runtime: runtime,
		restart: createRuntime,
		trace: trace,
		observedJournals: observedJournals,
		eventIds: eventIds,

        start: function () {
			var proposal = planned.execute({
				store: runtime.store,
				title: titles.root,
				platform: platform,
				event: { type: "test" },
				handler: resolveExecutor("root"),
				newId: runtime.newId
			});

			var work = proposalWork.convert(
				proposal,
				runtime.newId()
			);

			var title = runtime.continuations.accept(work);
			var results = runtime.continuations.resume(title);
			var pending = runtime.continuations.pending(title);

			return {
				status: "completed",
				obligation: title,
				results: results,
				pending: pending,
				flow: runtime.drainFlows()
			};
		}
	};
}

function continuationErrors(result) {
	var errors = [];

	result.continuations.forEach(function (pass) {
		errors = errors.concat(pass.errors);
	});

	return errors;
}

function testSingleJournalCascade(tw) {
	var f = fixture(tw);

	var result = f.start();

	assert(result.status === "completed");
	assert(result.obligation);
	assert(result.flow.errors.length === 0);
	assert(continuationErrors(result.flow).length === 0);

	assert(f.trace.join(",") === "root,manager,worker");
	assert(f.observedJournals.length === 2);
	assert(new Set(f.observedJournals).size === 1);
	assert(f.observedJournals[0] === result.obligation);

	assert(f.eventIds.length === 2);
	assert(f.eventIds[0] !== f.eventIds[1]);

	assert(!f.wiki.tiddlerExists(result.obligation));

	var worker = JSON.parse(
		f.wiki.getTiddlerText(f.titles.worker)
	);

	assert(worker.received.data === 42);
}

function testForwardingPublicationInterruption(tw) {
	var f = fixture(tw);
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		/*
			Stop before publishing the manager's outgoing event.

			The root's emission-only work also has one emission,
			so identify the manager by its work block.
		*/
		if (
			effect.before &&
			effect.after &&
			effect.before["clerus-wal-kind"] === "continuation" &&
			effect.after["clerus-wal-kind"] === "continuation" &&
			!injected
		) {
			var before = JSON.parse(effect.before.text);
			var after = JSON.parse(effect.after.text);

			if (
				before.work &&
				before.work.blocks.indexOf(
					f.titles.manager
				) !== -1 &&
				after.work === null
			) {
				injected = true;
				throw new Error(
					"Interrupted manager event publication"
				);
			}
		}

		return originalApply.call(this, effect);
	};

	var result;

	try {
		result = f.start();
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(f.trace.join(",") === "root,manager");

	var errors = continuationErrors(result.flow);

	assert(errors.length === 1);
	assert(errors[0].result.phase === "materialization");

	var journal = f.wiki.getTiddler(result.obligation);
	var record = JSON.parse(journal.fields.text);

	assert(record.work);
	assert(
		record.work.blocks.indexOf(f.titles.manager) !== -1
	);
	assert(record.work.emits.length === 1);
	assert(journal.fields["clerus-custody"] === "user");

	f.wiki.addTiddler(new tw.Tiddler(journal, {
		"clerus-custody": f.platform
	}));

	var restarted = f.restart();

	restarted.recover();

	/*
		Recovery publishes the event but does not invoke the worker.
	*/
	assert(f.trace.join(",") === "root,manager");

	var drained = restarted.drainFlows();

	assert(continuationErrors(drained).length === 0);
	assert(f.trace.join(",") === "root,manager,worker");
	assert(!f.wiki.tiddlerExists(result.obligation));
}

function testFailurePreservesForwardedInput(tw) {
	var f = fixture(tw, { failManager: true });

	var result = f.start();

	assert(f.trace.join(",") === "root,manager");

	var errors = continuationErrors(result.flow);

	assert(errors.length === 1);
	assert(errors[0].result.phase === "reaction");

	var journal = f.wiki.getTiddler(result.obligation);
	var record = JSON.parse(journal.fields.text);
	var ids = Object.keys(record.events);

	assert(record.work === null);
	assert(ids.length === 1);
	assert(record.events[ids[0]].mode === "paused");
	assert(
		record.events[ids[0]].event.registry.input.data === 42
	);
	assert(journal.fields["clerus-custody"] === "user");

	f.runtime.drainFlows();

	assert(f.trace.join(",") === "root,manager");
}

exports.run = function (tw) {
	var cases = [
		["persistent cascade shares one v2 journal", testSingleJournalCascade],
		["forwarding resumes without replaying manager", testForwardingPublicationInterruption],
		["failed recipient preserves forwarded input", testFailurePreservesForwardedInput]
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