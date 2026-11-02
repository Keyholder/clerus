/*\
title: $:/plugins/clerus/tests/core/retention-integration.js
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

function createEnvironment(tw, handlers) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var sequence = 0;

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "retention-integration-" +
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
			var registry = Object.assign({
				charter: {
					form: "charter",
					status: {}
				}
			}, extra || {});

			wiki.addTiddler(new tw.Tiddler({
				title: title,
				type: "application/json",
				"clerus-custody": platform,
				"clerus-executor": executor,
				text: JSON.stringify(registry)
			}));
		},

		retention: function () {
			return runtime.inspect().retention;
		}
	};
}

function retained(report, title, kind) {
	return report.retained.some(function (entry) {
		return entry.title === title &&
			entry.reasons.some(function (reason) {
				return reason.kind === kind;
			});
	});
}

function testPendingDeliveryNotSenderHistory(tw) {
	var source = "$:/clerus/jobs/retention-live-source";
	var target = "$:/clerus/jobs/retention-live-target";
	var handlers = {};

	handlers.source = function (event, operational) {
		var outgoing = operational.outgoing();

		operational.copy("note", outgoing, "input");
		operational.get("target").order(outgoing);

		// The accepted message must now retain the target by itself.
		operational.destroy("target");
	};

	var f = createEnvironment(tw, handlers);

	f.write(source, "source", {
		target: target,
		note: { form: "memo", data: 42 }
	});

	f.write(target, "target");

	var result = f.runtime.dispatch(
		source,
		{ type: "test" }
	);

	assert(result.flow.unavailable.length === 1);

	var pending = f.retention();

	assert(pending.complete);
	assert(retained(pending, target, "pending-message"));
	assert(pending.candidates.includes(source));

	handlers.target = function () {
		throw new Error("Target rejected delivery");
	};

	var delivered = f.runtime.drainFlows();

	assert(delivered.errors.length === 1);

	var historical = f.retention();

	assert(historical.complete);
	assert(historical.valid);
	assert(historical.retained.length === 0);
	assert(historical.candidates.includes(source));
	assert(historical.candidates.includes(target));

	var journal = f.wiki.getTiddler(result.obligation);
	var body = JSON.parse(journal.fields.text);

	assert(journal.fields["clerus-custody"] === "user");
	assert(body.errors.length === 1);
	assert(body.pending.length === 0);
}

function testPausedTickRetainsButFailedTickDoesNot(tw) {
	var owner = "$:/clerus/jobs/retention-live-tick";
	var ticks = 0;

	var f = createEnvironment(tw, {
		owner: function (event, operational) {
			if (event.type === "suspended") {
				return;
			}

			if (event.type === "tick") {
				ticks++;
				throw new Error("Tick failed");
			}

			operational.get("charter").defer();
		}
	});

	f.write(owner, "owner");

	f.runtime.dispatch(owner, { type: "schedule" });

	var waiting = f.retention();

	assert(waiting.complete);
	assert(retained(waiting, owner, "deferred-event"));

	var journals = f.runtime.store.snapshot().materialized.filter(
		function (fields) {
			return fields["clerus-wal-kind"] === "deferred";
		}
	);

	assert(journals.length === 1);

	var title = journals[0].title;

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(title),
		{ "clerus-custody": "user" }
	));

	var paused = f.retention();

	assert(paused.complete);
	assert(retained(paused, owner, "deferred-event"));

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(title),
		{ "clerus-custody": f.platform }
	));

	var ticked = f.runtime.runDeferred();

	assert(ticked.persistent[0].result.phase === "reaction");
	assert(ticks === 1);

	var completed = f.retention();

	assert(completed.complete);
	assert(completed.candidates.includes(owner));

	var historical = f.wiki.getTiddler(title);

	assert(historical.fields["clerus-wal-kind"] === "flow");
	assert(historical.fields["clerus-deferred-effect"]);
	assert(
		JSON.parse(historical.fields.text).errors[0].event.type ===
			"tick"
	);
}

function testAcceptedBirthRetainsWithoutSuperiorReference(tw) {
	var founder = "$:/clerus/jobs/retention-live-founder";
	var initialized = 0;

	var f = createEnvironment(tw, {
		founder: function (event, operational) {
			var child = operational.get("charter").createTitle(
				"worker",
				operational,
				"child"
			);

			var outgoing = operational.outgoing();

			operational.move("contract", outgoing, "contract");
			child.order(outgoing);

			/*
				The founding message was authorized before this
				explicit removal. Its accepted obligation remains.
			*/
			operational.destroy("child");
		},

		initializer: function (event, operational, incoming) {
			initialized++;

			incoming.get("contract").accept(
				"charter",
				{ phase: "initialized" }
			);
		}
	});

	f.write(founder, "founder", {
		contract: {
			form: "contract",
			executor: "initializer",
			temp: false
		}
	});

	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (
			!injected &&
			effect.before === null &&
			effect.after &&
			effect.after["clerus-executor"] === "initializer"
		) {
			injected = true;
			throw new Error("Interrupted after materialized birth");
		}

		return result;
	};

	var result;

	try {
		result = f.runtime.dispatch(
			founder,
			{ type: "found" }
		);
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(result.flow.errors.length === 1);
	assert(initialized === 1);

	var child = result.pending[0].recipient.title;
	var pending = f.retention();

	assert(pending.complete);
	assert(retained(pending, child, "accepted-birth"));
	assert(pending.candidates.includes(founder));

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(result.obligation),
		{ "clerus-custody": f.platform }
	));

	f.runtime.recover();

	assert(initialized === 1);
	assert(!f.wiki.getTiddler(result.obligation));

	var completed = f.retention();

	assert(completed.complete);
	assert(completed.candidates.includes(child));
	assert(completed.candidates.includes(founder));
}

exports.run = function (tw) {
	var cases = [
		["retention integration: pending delivery retains but sender history does not", testPendingDeliveryNotSenderHistory],
		["retention integration: paused tick retains but completed failure does not", testPausedTickRetainsButFailedTickDoesNot],
		["retention integration: accepted birth retains without superior reference", testAcceptedBirthRetainsWithoutSuperiorReference]
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