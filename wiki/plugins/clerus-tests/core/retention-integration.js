/*\
title: $:/plugins/clerus/tests/core/retention-integration.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var observation = require(
	"$:/plugins/clerus/tests/protocol-observation.js"
);

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

	assert(
		observation.attempts(result.flow).unavailable.length === 1
	);

	var pending = f.retention();

	assert(pending.complete);
	assert(retained(pending, target, "waiting-event"));
	assert(pending.candidates.includes(source));

	handlers.target = function () {
		throw new Error("Target rejected delivery");
	};

	var delivered = f.runtime.drainFlows();

	assert(
		observation.attempts(delivered).errors.length === 1
	);

	var paused = f.retention();

	assert(paused.complete);
	assert(paused.valid);
	assert(paused.candidates.includes(source));
	assert(retained(paused, target, "waiting-event"));

	var journal = f.wiki.getTiddler(result.obligation);
	var body = JSON.parse(journal.fields.text);
	var ids = Object.keys(body.events);

	assert(journal.fields["clerus-custody"] === "user");
	assert(body.work === null);
	assert(body.diagnostics.length === 1);
	assert(ids.length === 1);
	assert(body.events[ids[0]].mode === "paused");

	body.diagnostics.push({
		event: ids[0],
		action: "user-terminated",
		snapshot: body.events[ids[0]].event
	});

	delete body.events[ids[0]];

	f.wiki.addTiddler(new tw.Tiddler(journal, {
		text: JSON.stringify(body)
	}));

	var historical = f.retention();

	assert(historical.complete);
	assert(historical.valid);
	assert(historical.retained.length === 0);
	assert(historical.candidates.includes(source));
	assert(historical.candidates.includes(target));
}

function testPausedActivationRetainsUntilExplicitlyTerminated(tw) {
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
	assert(retained(waiting, owner, "waiting-event"));

	var journals = f.runtime.store.snapshot().materialized.filter(
		function (fields) {
			if (fields["clerus-wal-kind"] !== "continuation") {
				return false;
			}

			var record = JSON.parse(fields.text);

			return Object.keys(record.events).some(function (id) {
				return record.events[id].event.kind === "activation";
			});
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
	assert(retained(paused, owner, "waiting-event"));

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(title),
		{ "clerus-custody": f.platform }
	));

	var ticked = f.runtime.runDeferred();

	assert(ticked.activations[0].result.phase === "reaction");
	assert(ticks === 1);

	var failedJournal = f.wiki.getTiddler(title);
	var record = JSON.parse(failedJournal.fields.text);
	var ids = Object.keys(record.events);

	assert(record.kind === "continuation");
	assert(ids.length === 1);
	assert(record.events[ids[0]].event.kind === "activation");
	assert(record.events[ids[0]].mode === "paused");

	var held = f.retention();

	assert(held.complete);
	assert(retained(held, owner, "waiting-event"));

	delete record.events[ids[0]];

	f.wiki.addTiddler(new tw.Tiddler(failedJournal, {
		text: JSON.stringify(record)
	}));

	var historical = f.retention();

	assert(historical.complete);
	assert(historical.candidates.includes(owner));
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
	assert(
		observation.attempts(result.flow).errors.length === 1
	);
	assert(initialized === 1);

	var child = result.pending[0].recipient.title;
	var pending = f.retention();

	assert(pending.complete);
	assert(retained(pending, child, "accepted-work"));
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
		["retention integration: paused activation retains until explicitly terminated", testPausedActivationRetainsUntilExplicitlyTerminated],
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