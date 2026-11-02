/*\
title: $:/plugins/clerus/tests/core/mixed-egress.js
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

function fixture(tw, settings) {
	settings = settings || {};

	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/";

	var titles = {
		root: "$:/clerus/jobs/egress-root",
		manager: prefix + "egress-manager",
		worker: prefix + "egress-worker"
	};

	var trace = [];
	var ids = [];
	var sequence = 0;

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

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "mixed-egress-" +
				String(sequence).padStart(12, "0");
		},

		resolveExecutor: function (name) {
			return function (event, operational, incoming) {
				if (event.type === "dismissed") {
					trace.push(name + ":dismissed");
					return;
				}

				trace.push(name);

				if (name === "root") {
					var outgoing = operational.outgoing();

					operational.copy("note", outgoing, "input");
					operational.get("manager").order(outgoing);
					return;
				}

				if (name === "manager") {
					ids.push(event.id);

					if (settings.failManager) {
						throw new Error("Ephemeral manager failed");
					}

					operational.get("charter").setStatus({
						phase: "received"
					});

					var forwarded = incoming.outgoing();

					incoming.move("input", forwarded, "input");
					operational.get("worker").order(forwarded);
					return;
				}

				incoming.move("input", operational, "received");
			};
		}
	});

	return {
		wiki: wiki,
		titles: titles,
		trace: trace,
		ids: ids,
		runtime: runtime
	};
}

function testPersistentOrderReachesEphemeralChain(tw) {
	var f = fixture(tw);

	var result = f.runtime.dispatch(
		f.titles.root,
		{ type: "test" }
	);

	assert(result.status === "completed");
	assert(result.flow.errors.length === 0);
	assert(result.flow.completed.length === 1);
	assert(f.trace.join(",") === "root,manager,worker");
	assert(f.ids[0]);

	assert(result.flow.remaining === 0);
	assert(result.flow.ephemeralRemaining === 0);
	assert(!f.wiki.getTiddler(result.obligation));

	var worker = JSON.parse(
		f.wiki.getTiddler(f.titles.worker).fields.text
	);

	assert(worker.received.data === 42);
}

function testEphemeralFailureBecomesFlowEvidence(tw) {
	var f = fixture(tw, { failManager: true });

	var result = f.runtime.dispatch(
		f.titles.root,
		{ type: "test" }
	);

	assert(result.flow.errors.length === 1);
	assert(result.flow.errors[0].result.phase === "reaction");
	assert(result.flow.errors[0].result.lifecycle.dismissed);

	assert(
		f.trace.join(",") ===
			"root,manager,manager:dismissed"
	);

	assert(
		f.wiki.getTiddler(f.titles.manager)
			.fields["clerus-custody"] === "user"
	);

	var journal = f.wiki.getTiddler(result.obligation);
	var record = JSON.parse(journal.fields.text);

	assert(journal.fields["clerus-custody"] === "user");
	assert(record.errors.length === 1);
	assert(record.pending.length === 0);
}

function testInfrastructureFailurePreservesPendingDelivery(tw) {
	var f = fixture(tw);
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		if (effect.title === f.titles.manager && !injected) {
			injected = true;
			throw new Error("Injected ephemeral write failure");
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
	assert(result.flow.errors[0].result.phase === "materialization");
	assert(result.flow.remaining === 1);
	assert(!result.flow.errors[0].result.lifecycle);
	assert(f.ids.length === 1);

	var retried = f.runtime.drainFlows();

	assert(retried.errors.length === 0);
	assert(retried.remaining === 0);
	assert(retried.ephemeralRemaining === 0);

	assert(f.ids.length === 2);
	assert(f.ids[0] === f.ids[1]);
	assert(!f.wiki.getTiddler(result.obligation));
}

exports.run = function (tw) {
	var cases = [
		["mixed egress: persistent order drains ephemeral continuations", testPersistentOrderReachesEphemeralChain],
		["mixed egress: executor failure preserves flow evidence", testEphemeralFailureBecomesFlowEvidence],
		["mixed egress: infrastructure failure preserves pending identity", testInfrastructureFailurePreservesPendingDelivery]
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