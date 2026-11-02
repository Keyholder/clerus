/*\
title: $:/plugins/clerus/core2/tests/runtime-flows.js
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

function fixture(tw, settings) {
	settings = settings || {};

	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var titles = {
		root: "$:/clerus/jobs/runtime-flow-root",
		manager: "$:/clerus/jobs/runtime-flow-manager",
		worker: "$:/clerus/jobs/runtime-flow-worker"
	};

	var calls = {
		root: 0,
		manager: 0,
		worker: 0,
		suspended: 0
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
		note: { form: "memo", data: 42 }
	});

	write("manager", {
		worker: titles.worker
	});

	write("worker");

	var sequence = 0;

	function handler(name) {
		return function (event, operational, incoming) {
			if (event.type === "suspended") {
				calls.suspended++;
				return;
			}

			calls[name]++;

			if (name === "root") {
				var outgoing = operational.outgoing();

				operational.copy("note", outgoing, "input");
				operational.get("manager").order(outgoing);
				return;
			}

			if (name === "manager") {
				if (settings.failManager) {
					throw new Error("Manager rejected work");
				}

				var forwarded = operational.outgoing();

				incoming.move("input", forwarded, "input");
				operational.get("worker").order(forwarded);
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

				return "runtime-flow-" +
					String(sequence).padStart(12, "0");
			},

			resolveExecutor: handler
		});
	}

	return {
		wiki: wiki,
		platform: platform,
		titles: titles,
		calls: calls,
		createRuntime: createRuntime,
		runtime: createRuntime()
	};
}

function testDispatchDrainsFlow(tw) {
	var f = fixture(tw);

	var result = f.runtime.dispatch(
		f.titles.root,
		{ type: "test" }
	);

	assert(result.status === "completed");
	assert(result.flow.completed.length === 2);
	assert(result.flow.errors.length === 0);
	assert(result.flow.remaining === 0);

	assert(f.calls.root === 1);
	assert(f.calls.manager === 1);
	assert(f.calls.worker === 1);

	assert(!f.wiki.getTiddler(result.obligation));

	var registry = JSON.parse(
		f.wiki.getTiddler(f.titles.worker).fields.text
	);

	assert(registry.received.data === 42);
}

function testFailedRecipientIsSuspended(tw) {
	var f = fixture(tw, { failManager: true });

	var result = f.runtime.dispatch(
		f.titles.root,
		{ type: "test" }
	);

	assert(result.status === "completed");
	assert(result.flow.errors.length === 1);
	assert(result.flow.errors[0].result.lifecycle.suspended);
	assert(f.calls.manager === 1);
	assert(f.calls.worker === 0);
	assert(f.calls.suspended === 1);

	assert(
		f.wiki.getTiddler(f.titles.manager)
			.fields["clerus-custody"] === "user"
	);

	var record = JSON.parse(
		f.wiki.getTiddler(result.obligation).fields.text
	);

	assert(record.errors.length === 1);
	assert(record.pending.length === 0);
}

function testRecoveryQueuesWithoutCallingHandlers(tw) {
	var f = fixture(tw);
	var originalApply = f.runtime.store.apply;
	var injected = false;

	/*
		The manager's reaction is message-only. Interrupt the
		transition from its accepted plan to pending worker delivery.
	*/
	f.runtime.store.apply = function (effect) {
		if (
			!injected &&
			effect.after &&
			effect.after["clerus-wal-kind"] === "flow"
		) {
			var record = JSON.parse(effect.after.text);

			if (
				record.active === null &&
				record.pending.some(function (message) {
					return message.recipient.title === f.titles.worker;
				})
			) {
				injected = true;
				throw new Error("Interrupted before registering worker delivery");
			}
		}

		return originalApply.call(this, effect);
	};

	var result;

	try {
		result = f.runtime.dispatch(
			f.titles.root,
			{ type: "test" }
		);
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(result.flow.errors.length === 1);
	assert(f.calls.root === 1);
	assert(f.calls.manager === 1);
	assert(f.calls.worker === 0);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(result.obligation),
		{ "clerus-custody": f.platform }
	));

	var restarted = f.createRuntime();
	var recovery = restarted.recover();

	assert(recovery.pendingFlowAttempts === 1);
	assert(f.calls.manager === 1);
	assert(f.calls.worker === 0);

	var completed = restarted.drainFlows();

	assert(completed.completed.length === 1);
	assert(completed.errors.length === 0);
	assert(f.calls.root === 1);
	assert(f.calls.manager === 1);
	assert(f.calls.worker === 1);
	assert(!f.wiki.getTiddler(result.obligation));
}

exports.run = function (tw) {
	var cases = [
		["runtime flows: dispatch drains available continuations", testDispatchDrainsFlow],
		["runtime flows: recipient failure applies suspension policy", testFailedRecipientIsSuspended],
		["runtime flows: recovery queues work without invoking handlers", testRecoveryQueuesWithoutCallingHandlers]
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