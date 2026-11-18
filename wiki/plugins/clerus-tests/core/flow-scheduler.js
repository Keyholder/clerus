/*\
title: $:/plugins/clerus/tests/core/flow-scheduler.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var continuationRoot = require(
	"$:/plugins/clerus/tests/continuation-root.js"
);

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw, handlers) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var titles = {
		root: "$:/clerus/jobs/queue-flow-root",
		manager: "$:/clerus/jobs/queue-flow-manager",
		worker: "$:/clerus/jobs/queue-flow-worker"
	};

	function write(name, extra) {
		var registry = Object.assign({
			charter: {
				form: "charter",
				status: {}
			}
		}, extra || {});

		wiki.addTiddler(new tw.Tiddler({
			title: titles[name],
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": name,
			text: JSON.stringify(registry)
		}));
	}

	write("root", {
		manager: titles.manager,
		worker: titles.worker,
		note: { form: "memo", data: 42 }
	});

	write("manager", {
		worker: titles.worker
	});

	write("worker");

	var sequence = 0;

	function newId() {
		sequence++;

		return "flow-queue-" +
			String(sequence).padStart(16, "0");
	}

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		newId: newId,

		resolveExecutor: function (name) {
			return handlers[name];
		}
	});

	var store = runtime.store;

	return {
		wiki: wiki,
		titles: titles,
		runtime: runtime,

		root: function (handler) {
			return continuationRoot.start({
				store: store,
				title: titles.root,
				platform: platform,
				event: { type: "test" },
				handler: handler,
				newId: newId
			});
		},

		registry: function (name) {
			return JSON.parse(
				wiki.getTiddler(titles[name]).fields.text
			);
		}
	};
}

function send(operational, target, source, key) {
	var outgoing = operational.outgoing();

	source.move(key, outgoing, "input");
	operational.get(target).order(outgoing);
}

function testCascadeCompletesSynchronously(tw) {
	var trace = [];

	var f = fixture(tw, {
		manager: function (event, operational, incoming) {
			trace.push("manager");

			send(operational, "worker", incoming, "input");
		},

		worker: function (event, operational, incoming) {
			trace.push("worker");

			incoming.move("input", operational, "received");
		}
	});

	var root = f.root(function (event, operational) {
		var outgoing = operational.outgoing();

		operational.copy("note", outgoing, "input");
		operational.get("manager").order(outgoing);
	});

	assert(root.status === "completed");
	assert(root.pending.length === 1);

	var report = f.runtime.drainFlows();

	assert(trace.join(",") === "manager,worker");
	assert(report.completed.length === 2);
	assert(report.errors.length === 0);
	assert(report.remaining === 0);
	assert(f.registry("worker").received.data === 42);
	assert(!f.wiki.getTiddler(root.obligation));

	var repeated = f.runtime.drainFlows();

	assert(repeated.completed.length === 0);
	assert(repeated.errors.length === 0);
	assert(trace.join(",") === "manager,worker");
}

function testUnavailableExecutorPreservesMessage(tw) {
	var calls = 0;
	var handlers = {};

	var f = fixture(tw, handlers);

	var root = f.root(function (event, operational) {
		var outgoing = operational.outgoing();

		operational.copy("note", outgoing, "input");
		operational.get("manager").order(outgoing);
	});

	var id = root.pending[0].id;

	var first = f.runtime.drainFlows();

	assert(first.unavailable.length === 1);
	assert(first.remaining === 1);
	assert(calls === 0);

	handlers.manager = function (event, operational, incoming) {
		calls++;
		assert(event.id === id);
		incoming.destroy("input");
	};

	var second = f.runtime.drainFlows();

	assert(second.completed.length === 1);
	assert(second.errors.length === 0);
	assert(second.remaining === 0);
	assert(calls === 1);
	assert(!f.wiki.getTiddler(root.obligation));
}

function testFailedBranchDoesNotStopSibling(tw) {
	var received = 0;

	var f = fixture(tw, {
		manager: function (event) {
			if (event.type === "suspended") {
				return;
			}

			throw new Error("Manager failed");
		},

		worker: function (event, operational, incoming) {
			received++;
			incoming.destroy("input");
		}
	});

	var root = f.root(function (event, operational) {
		["manager", "worker"].forEach(function (target) {
			var outgoing = operational.outgoing();

			operational.copy("note", outgoing, "input");
			operational.get(target).order(outgoing);
		});
	});

	var report = f.runtime.drainFlows();

	assert(report.errors.length === 1);
	assert(report.completed.length === 1);
	assert(report.remaining === 0);
	assert(received === 1);

	var journal = f.wiki.getTiddler(root.obligation);
	var record = JSON.parse(journal.fields.text);

	assert(journal.fields["clerus-custody"] === "user");
	assert(record.version === 2);
	assert(record.kind === "continuation");
	assert(record.work === null);
	assert(record.diagnostics.length === 1);

	var ids = Object.keys(record.events);

	assert(ids.length === 1);
	assert(record.events[ids[0]].mode === "paused");
	assert(
		record.events[ids[0]].event.recipient.executor === "manager"
	);
	assert(record.events[ids[0]].event.registry.input.data === 42);
}

exports.run = function (tw) {
	var cases = [
		["flow scheduler: causal cascade completes synchronously", testCascadeCompletesSynchronously],
		["flow scheduler: unavailable executor preserves pending identity", testUnavailableExecutorPreservesMessage],
		["flow scheduler: failed branch does not stop sibling", testFailedBranchDoesNotStopSibling]
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