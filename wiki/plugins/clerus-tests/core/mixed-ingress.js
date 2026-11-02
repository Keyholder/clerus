/*\
title: $:/plugins/clerus/tests/core/mixed-ingress.js
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

function fixture(tw, senderFails) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";

	var titles = {
		director: "$:/clerus/jobs/ingress-director",
		peer: "$:/clerus/jobs/ingress-peer",
		worker: "$:/temp/clerus/jobs/" + platform + "/ingress-worker"
	};

	var project = "Core2 Ingress Project";
	var trace = [];
	var sequence = 0;

	function write(name, registry) {
		registry.charter = {
			form: "charter",
			status: { phase: "initial" }
		};

		wiki.addTiddler(new tw.Tiddler({
			title: titles[name],
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": name,
			text: JSON.stringify(registry)
		}));
	}

	write("director", {
		mission: {
			form: "mission",
			project: project,
			role: [],
			link: "10",
			issued: "1",
			children: { item: "10/1" }
		},
		worker: titles.worker,
		peer: titles.peer
	});

	write("worker", {
		mission: {
			form: "mission",
			project: project,
			role: ["item"],
			link: "10/1",
			issued: "0",
			children: {}
		},
		evidence: { form: "memo", data: 42 }
	});

	write("peer", {});

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "mixed-ingress-" +
				String(sequence).padStart(12, "0");
		},

		resolveExecutor: function (name) {
			if (name === "worker") {
				return function (event, operational) {
					if (event.type === "dismissed") {
						trace.push("worker:dismissed");
						return;
					}

					trace.push("worker:start");

					var outgoing = operational.outgoing();

					operational.copy("evidence", outgoing, "result");
					operational.get("mission").report(outgoing);

					assert(trace.join(",") === "worker:start");

					operational.get("charter").setStatus({
						phase: "reported"
					});

					if (senderFails) {
						throw new Error("Failure after ephemeral report");
					}

					trace.push("worker:end");
				};
			}

			if (name === "director") {
				return function (event, operational, incoming) {
					assert(event.type === "report");
					assert(event.id);
					assert(event.project === project);
					assert(event.role.join("/") === "item");
					assert(!("source" in event));

					trace.push("director:report");

					var stored = JSON.parse(
						wiki.getTiddler(titles.worker).fields.text
					);

					assert(stored.charter.status.phase === "reported");

					var outgoing = incoming.outgoing();

					incoming.move("result", outgoing, "result");
					operational.get("peer").order(outgoing);

					operational.get("charter").setStatus({
						phase: "forwarded"
					});

					assert(
						JSON.parse(
							wiki.getTiddler(titles.director).fields.text
						).charter.status.phase === "initial"
					);
				};
			}

			if (name === "peer") {
				return function (event, operational, incoming) {
					trace.push("peer:order");

					incoming.move("result", operational, "received");
				};
			}
		}
	});

	return {
		wiki: wiki,
		titles: titles,
		trace: trace,
		runtime: runtime
	};
}

function testEphemeralReportStartsPersistentFlow(tw) {
	var f = fixture(tw, false);

	var result = f.runtime.dispatch(
		f.titles.worker,
		{ type: "test" }
	);

	assert(
		f.trace.join(",") ===
			"worker:start,worker:end,director:report,peer:order"
	);

	assert(result.errors.length === 0);
	assert(result.persistent.length === 1);
	assert(result.persistent[0].result.status === "completed");
	assert(result.persistent[0].result.obligation);

	assert(result.flow.completed.length === 1);
	assert(result.flow.errors.length === 0);

	var peer = JSON.parse(
		f.wiki.getTiddler(f.titles.peer).fields.text
	);

	assert(peer.received.data === 42);
}

function testSenderFailureDoesNotCancelAcceptedReport(tw) {
	var f = fixture(tw, true);

	var result = f.runtime.dispatch(
		f.titles.worker,
		{ type: "test" }
	);

	assert(result.errors.length === 1);
	assert(result.persistent.length === 1);
	assert(result.persistent[0].result.status === "completed");
	assert(result.flow.completed.length === 1);

	assert(
		f.wiki.getTiddler(f.titles.worker)
			.fields["clerus-custody"] === "user"
	);

	var peer = JSON.parse(
		f.wiki.getTiddler(f.titles.peer).fields.text
	);

	assert(peer.received.data === 42);
	assert(f.trace.includes("director:report"));
	assert(f.trace.includes("peer:order"));
}

exports.run = function (tw) {
	var cases = [
		["mixed ingress: ephemeral report begins persistent work", testEphemeralReportStartsPersistentFlow],
		["mixed ingress: sender failure does not cancel accepted report", testSenderFailureDoesNotCancelAcceptedReport]
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