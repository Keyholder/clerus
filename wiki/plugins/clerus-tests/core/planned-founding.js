/*\
title: $:/plugins/clerus/tests/core/planned-founding.js
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
	var founder = "$:/clerus/jobs/planned-founding-owner";
	var sequence = 0;
	var births = 0;

	function contract() {
		return {
			form: "contract",
			executor: "worker",
			temp: false,
			book: { instruction: "initialize" }
		};
	}

	wiki.addTiddler(new tw.Tiddler({
		title: founder,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "founder",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			contract: contract(),
			secondContract: contract(),
			note: { form: "memo", data: 42 }
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "planned-founding-" +
				String(sequence).padStart(12, "0");
		},

		resolveExecutor: function (name) {
			if (name === "founder") {
				return function (event, operational) {
					var child;

					if (event.type === "retry-foundation") {
						child = operational.get("child");
					} else {
						child = operational.get("charter").createTitle(
							"worker",
							operational,
							"child"
						);
					}

					var outgoing = operational.outgoing();

					operational.move(
						event.type === "retry-foundation"
							? "secondContract"
							: "contract",
						outgoing,
						"contract"
					);

					operational.copy("note", outgoing, "note");
					child.order(outgoing);

					if (settings.failFounder) {
						throw new Error("Founder rejected proposal");
					}
				};
			}

			if (name === "worker" && !settings.workerUnavailable) {
				return function (event, operational, incoming) {
					births++;

					assert(!wiki.getTiddler(event.title));

					var charter = incoming.get("contract").accept(
						"charter",
						{ phase: "starting" }
					);

					assert(!wiki.getTiddler(event.title));
					assert(
						charter.book().instruction === "initialize"
					);

					incoming.move("note", operational, "received");
					charter.setStatus({ phase: "running" });
				};
			}
		}
	});

	return {
		wiki: wiki,
		founder: founder,
		runtime: runtime,

		births: function () {
			return births;
		},

		registry: function () {
			return JSON.parse(
				wiki.getTiddler(founder).fields.text
			);
		}
	};
}

function testCompleteFoundingPath(tw) {
	var f = fixture(tw);

	var result = f.runtime.dispatch(
		f.founder,
		{ type: "found" }
	);

	assert(result.status === "completed");
	assert(result.flow.errors.length === 0);
	assert(result.flow.completed.length === 1);
	assert(result.flow.remaining === 0);
	assert(f.births() === 1);

	var founder = f.registry();

	assert(founder.child);
	assert(!founder.contract);
	assert(founder.secondContract);

	var child = f.wiki.getTiddler(founder.child);
	var registry = JSON.parse(child.fields.text);

	assert(child.fields["clerus-executor"] === "worker");
	assert(registry.charter.status.phase === "running");
	assert(registry.received.data === 42);
	assert(!f.wiki.getTiddler(result.obligation));
}

function testFounderFailureDiscardsBirthRequest(tw) {
	var f = fixture(tw, { failFounder: true });
	var before = f.wiki.getTiddler(f.founder).fields.text;

	var result = f.runtime.dispatch(
		f.founder,
		{ type: "found" }
	);

	assert(result.status === "failed");
	assert(result.phase === "reaction");
	assert(f.births() === 0);

	// Suspension changes lifecycle fields, not documents.
	assert(f.wiki.getTiddler(f.founder).fields.text === before);
	assert(!f.registry().child);
	assert(f.registry().contract);
}

function testAcceptedReservationPreventsSecondFounding(tw) {
	var f = fixture(tw, { workerUnavailable: true });

	var first = f.runtime.dispatch(
		f.founder,
		{ type: "found" }
	);

	assert(first.status === "completed");
	assert(first.flow.unavailable.length === 1);
	assert(first.flow.remaining === 1);
	assert(f.births() === 0);

	var before = f.wiki.getTiddler(f.founder).fields.text;
	var journalBefore =
		f.wiki.getTiddler(first.obligation).fields.text;

	var second = f.runtime.dispatch(
		f.founder,
		{ type: "retry-foundation" }
	);

	assert(second.status === "failed");
	assert(second.phase === "acceptance");
	assert(
		second.error.message.indexOf(
			"Establishment address is reserved:"
		) !== -1,
		"Second founding must be rejected by the accepted address reservation"
	);

	assert(f.wiki.getTiddler(f.founder).fields.text === before);
	assert(
		f.wiki.getTiddler(first.obligation).fields.text === journalBefore
	);
	assert(f.registry().secondContract);
	assert(!f.wiki.getTiddler(f.registry().child));
	assert(f.births() === 0);
	assert(second.obligation === null);
	assert(!second.acceptanceUncertain);

	var journals = [];

	f.wiki.each(function (tiddler, title) {
		if (
			title.indexOf("$:/clerus/wal/") === 0
		) {
			journals.push(title);
		}
	});

	assert(
		journals.length === 1 &&
		journals[0] === first.obligation,
		"Rejected founding must not create another journal"
	);
}

exports.run = function (tw) {
	var cases = [
		["planned founding: explicit preparation reaches persistent birth", testCompleteFoundingPath],
		["planned founding: failed founder proposal creates no request", testFounderFailureDiscardsBirthRequest],
		["planned founding: accepted reservation prevents duplicate birth", testAcceptedReservationPreventsSecondFounding]
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