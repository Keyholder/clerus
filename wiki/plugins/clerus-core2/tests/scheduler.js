/*\
title: $:/plugins/clerus/core2/tests/scheduler.js
type: application/javascript
module-type: library
\*/

"use strict";

var Scheduler = require(
	"$:/plugins/clerus/core2/scheduler.js"
).Scheduler;

var Store = require("$:/plugins/clerus/core2/store.js").Store;

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw, handlers) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/";
	var titles = {
		director: prefix + "queue-director",
		manager: prefix + "queue-manager",
		worker: prefix + "queue-worker"
	};

	function write(name, subordinate) {
		var registry = {
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			note: {
				form: "memo",
				data: { value: 42 }
			}
		};

		if (subordinate) {
			registry.subordinate = subordinate;
		}

		wiki.addTiddler(new tw.Tiddler({
			title: titles[name],
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": name,
			text: JSON.stringify(registry)
		}));
	}

	write("director", titles.manager);
	write("manager", titles.worker);
	write("worker");

	var scheduler = new Scheduler({
		platform: platform,

		store: new Store({
			wiki: wiki,
			Tiddler: tw.Tiddler
		}),

		readJobs: function () {
			return Object.keys(titles).filter(function (name) {
				return !!wiki.getTiddler(titles[name]);
			}).map(function (name) {
				var tiddler = wiki.getTiddler(titles[name]);

				return {
					title: titles[name],
					custody: tiddler.fields["clerus-custody"],
					registry: JSON.parse(tiddler.fields.text)
				};
			});
		},

		resolveExecutor: function (name) {
			return handlers[name];
		}
	});

	return {
		wiki: wiki,
		titles: titles,
		scheduler: scheduler,

		registry: function (name) {
			return JSON.parse(
				wiki.getTiddler(titles[name]).fields.text
			);
		}
	};
}

function send(operational, sourceRegistry, key) {
	var outgoing = operational.outgoing();

	sourceRegistry.move(key, outgoing, "instruction");
	operational.get("subordinate").order(outgoing);
}

function testCausalChain(tw) {
	var trace = [];
	var f;

	f = fixture(tw, {
		director: function (event, operational) {
			trace.push("director:start");

			var outgoing = operational.outgoing();

			operational.copy("note", outgoing, "instruction");
			operational.get("subordinate").order(outgoing);

			assert(trace.join(",") === "director:start");

			operational.get("charter").setStatus({
				phase: "sent"
			});

			trace.push("director:end");
		},

		manager: function (event, operational, incoming) {
			assert(event.type === "order");
			assert(!("source" in event));
			assert(f.registry("director").charter.status.phase === "sent");

			trace.push("manager");

			send(operational, incoming, "instruction");
		},

		worker: function (event, operational, incoming) {
			trace.push("worker");

			assert(incoming.get("instruction").data().value === 42);

			incoming.move(
				"instruction",
				operational,
				"received"
			);
		}
	});

	var result = f.scheduler.dispatch(
		f.titles.director,
		{ type: "test" }
	);

	assert(
		trace.join(",") ===
			"director:start,director:end,manager,worker"
	);

	assert(result.delivered.length === 3);
	assert(result.errors.length === 0);
	assert(result.skipped.length === 0);
	assert(f.scheduler.queue.length === 0);
	assert(f.registry("worker").received.data.value === 42);
}

function testFailureDoesNotCancelAcceptedWork(tw) {
	var received = 0;

	var f = fixture(tw, {
		director: function (event, operational) {
			var outgoing = operational.outgoing();

			operational.copy("note", outgoing, "instruction");
			operational.get("subordinate").order(outgoing);

			throw new Error("Sender failed after sending");
		},

		manager: function (event, operational, incoming) {
			received++;
			incoming.destroy("instruction");
		},

		worker: function () {}
	});

	var result = f.scheduler.dispatch(
		f.titles.director,
		{ type: "test" }
	);

	assert(received === 1);
	assert(result.errors.length === 1);
	assert(result.delivered.length === 1);
	assert(
		result.errors[0].error.message ===
			"Sender failed after sending"
	);
}

function testUnresolvedInputIsAnError(tw) {
	var f = fixture(tw, {
		director: function (event, operational) {
			var outgoing = operational.outgoing();

			operational.copy("note", outgoing, "instruction");
			operational.get("subordinate").order(outgoing);
		},

		manager: function () {
			// Deliberately leave the incoming document unresolved.
		},

		worker: function () {}
	});

	var result = f.scheduler.dispatch(
		f.titles.director,
		{ type: "test" }
	);

	assert(result.errors.length === 1);
	assert(
		result.errors[0].error.message.indexOf("unresolved") !== -1
	);
	assert(!f.registry("manager").instruction);
}

function testExecutorReplacementSkipsDelivery(tw) {
	var invoked = false;
	var f;

	f = fixture(tw, {
		director: function (event, operational) {
			var outgoing = operational.outgoing();

			operational.copy("note", outgoing, "instruction");
			operational.get("subordinate").order(outgoing);

			f.wiki.addTiddler(new tw.Tiddler(
				f.wiki.getTiddler(f.titles.manager),
				{ "clerus-executor": "replacement" }
			));
		},

		manager: function () {
			invoked = true;
		},

		replacement: function () {
			invoked = true;
		},

		worker: function () {}
	});

	var result = f.scheduler.dispatch(
		f.titles.director,
		{ type: "test" }
	);

	assert(!invoked);
	assert(result.skipped.length === 1);
	assert(result.errors.length === 0);
}

exports.run = function (tw) {
	var cases = [
		["scheduler: causal chain completes synchronously", testCausalChain],
		["scheduler: sender failure preserves accepted work", testFailureDoesNotCancelAcceptedWork],
		["scheduler: unresolved input is reported", testUnresolvedInputIsAnError],
		["scheduler: executor replacement prevents delivery", testExecutorReplacementSkipsDelivery]
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