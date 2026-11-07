/*\
title: $:/plugins/clerus/tests/core/material-birth.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var stores = require("$:/plugins/clerus/core/store.js");
var legacyRoot = require(
	"$:/plugins/clerus/tests/legacy-flow-root.js"
);

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function throws(fn, fragment) {
	var caught;

	try {
		fn();
	} catch (error) {
		caught = error;
	}

	assert(caught, "Expected an exception");

	if (fragment) {
		assert(
			String(caught.message).indexOf(fragment) !== -1,
			"Unexpected exception: " + caught.message
		);
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var target = "$:/clerus/jobs/material-birth-unique";
	var founder = "$:/clerus/jobs/material-birth-founder";
	var sequence = 0;
	var executorCalls = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: founder,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "founder",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: {}
			},
			target: target,
			contract: {
				form: "contract",
				temp: false,
				executor: "worker"
			}
		})
	}));

	function newId() {
		sequence++;

		return "material-birth-generated-" +
			String(sequence).padStart(12, "0");
	}

	function createRuntime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: newId,
			resolveExecutor: function () {
				return function () {
					executorCalls++;
					throw new Error(
						"Material birth must not invoke an executor"
					);
				};
			}
		});
	}

	var runtime = createRuntime();

	function birth() {
		return {
			version: 2,
			id: newId(),
			checks: [],
			transitions: [
				stores.transition(target, null, {
					title: target,
					type: "application/json",
					"clerus-custody": platform,
					"clerus-executor": "worker",
					text: JSON.stringify({
						charter: {
							form: "charter",
							book: {
								instruction: "already initialized"
							},
							status: {
								phase: "ready"
							}
						},
						note: {
							form: "memo",
							data: 42
						}
					})
				})
			],
			blocks: [],
			emits: []
		};
	}

	function establishingWork() {
		return {
			version: 2,
			id: newId(),
			checks: [],
			transitions: [],
			blocks: [],
			emits: [{
				id: newId(),
				event: {
					kind: "delivery",
					recipient: {
						title: target,
						executor: "worker"
					},
					type: "order",
					establishing: true,
					registry: {
						contract: {
							form: "contract",
							temp: false,
							executor: "worker"
						}
					}
				}
			}]
		};
	}

	function establishV1() {
		return legacyRoot.start({
			store: runtime.store,
			title: founder,
			platform: platform,
			event: { type: "test" },
			newId: newId,

			handler: function (event, operational) {
				var outgoing = operational.outgoing();

				operational.move(
					"contract",
					outgoing,
					"contract"
				);

				operational.get("target").order(outgoing);
			}
		});
	}

	return {
		wiki: wiki,
		platform: platform,
		target: target,
		runtime: runtime,
		restart: createRuntime,
		birth: birth,
		establishingWork: establishingWork,
		establishV1: establishV1,

		executorCalls: function () {
			return executorCalls;
		}
	};
}

function testDirectBirth(tw) {
	var f = fixture(tw);
	var title = f.runtime.continuations.accept(f.birth());

	assert(!f.wiki.tiddlerExists(f.target));

	var recovery = f.runtime.recover();

	assert(recovery.entries.some(function (entry) {
		return (
			entry.title === title &&
			entry.status === "completed"
		);
	}));

	var job = f.wiki.getTiddler(f.target);
	var registry = JSON.parse(job.fields.text);

	assert(job.fields["clerus-executor"] === "worker");
	assert(job.fields["clerus-custody"] === f.platform);
	assert(registry.charter.status.phase === "ready");
	assert(
		registry.charter.book.instruction === "already initialized"
	);
	assert(registry.note.data === 42);

	assert(f.executorCalls() === 0);
	assert(!f.wiki.tiddlerExists(title));
}

function testInterruptedBirthRetainsMaterializedJob(tw) {
	var f = fixture(tw);
	var title = f.runtime.continuations.accept(f.birth());
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.target && !injected) {
			injected = true;
			throw new Error("Interrupted after direct birth");
		}

		return result;
	};

	try {
		f.runtime.recover();
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(f.wiki.tiddlerExists(f.target));
	assert(
		f.wiki.getTiddler(title).fields["clerus-custody"] === "user"
	);

	var retention = f.runtime.inspect().retention;

	assert(retention.complete);
	assert(retention.retained.some(function (entry) {
		return (
			entry.title === f.target &&
			entry.reasons.some(function (reason) {
				return (
					reason.kind === "accepted-work" &&
					reason.wal === title
				);
			})
		);
	}));

	var collection = f.runtime.collect();

	assert(collection.removed.indexOf(f.target) === -1);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(title),
		{ "clerus-custody": f.platform }
	));

	var restarted = f.restart();
	var recovery = restarted.recover();

	assert(recovery.entries.some(function (entry) {
		return (
			entry.title === title &&
			entry.status === "completed" &&
			entry.results[0] === "already-applied"
		);
	}));

	assert(f.executorCalls() === 0);
	assert(!f.wiki.tiddlerExists(title));
}

function testV1ReservationBlocksMaterialBirth(tw) {
	var f = fixture(tw);
	var first = f.establishV1();
	var originalBody = f.wiki.getTiddlerText(first.obligation);

	throws(function () {
		f.runtime.continuations.accept(f.birth());
	}, "address is reserved");

	assert(!f.wiki.tiddlerExists(f.target));
	assert(
		f.wiki.getTiddlerText(first.obligation) === originalBody
	);
	assert(f.executorCalls() === 0);
}

function testMaterialBirthBlocksV1Establishment(tw) {
	var f = fixture(tw);
	var title = f.runtime.continuations.accept(f.birth());

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(title),
		{ "clerus-custody": "user" }
	));

	var originalBody = f.wiki.getTiddlerText(title);

	throws(function () {
		f.establishV1();
	}, "address is reserved");

	assert(!f.wiki.tiddlerExists(f.target));
	assert(f.wiki.getTiddlerText(title) === originalBody);
	assert(f.executorCalls() === 0);
}

function testV2EstablishmentBlocksMaterialBirth(tw) {
	var f = fixture(tw);
	var title = f.runtime.continuations.accept(
		f.establishingWork()
	);

	/*
		The reservation exists before publication.
	*/
	throws(function () {
		f.runtime.continuations.accept(f.birth());
	}, "address is reserved");

	f.runtime.continuations.resume(title);

	/*
		It still exists after publication and under user custody.
	*/
	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(title),
		{ "clerus-custody": "user" }
	));

	throws(function () {
		f.runtime.continuations.accept(f.birth());
	}, "address is reserved");

	assert(!f.wiki.tiddlerExists(f.target));
	assert(f.executorCalls() === 0);
}

function testDirectBirthBecomesCollectibleAfterCompletion(tw) {
	var f = fixture(tw);

	/*
		Remove the founder's ordinary operational reference:
		otherwise it independently retains the target.
	*/
	var founderTitle = "$:/clerus/jobs/material-birth-founder";
	var founder = f.wiki.getTiddler(founderTitle);
	var registry = JSON.parse(founder.fields.text);

	delete registry.target;

	f.wiki.addTiddler(new tw.Tiddler(founder, {
		text: JSON.stringify(registry)
	}));

	var title = f.runtime.continuations.accept(f.birth());

	f.runtime.recover();

	assert(!f.wiki.tiddlerExists(title));

	var view = f.runtime.inspect().retention;

	assert(view.complete);
	assert(view.candidates.indexOf(f.target) !== -1);

	var collected = f.runtime.collect();

	assert(collected.removed.indexOf(f.target) !== -1);
	assert(!f.wiki.tiddlerExists(f.target));
	assert(f.executorCalls() === 0);
}

exports.run = function (tw) {
	var cases = [
		["direct material birth invokes no executor", testDirectBirth],
		["interrupted birth retains the materialized job", testInterruptedBirthRetainsMaterializedJob],
		["v1 reservation blocks material birth", testV1ReservationBlocksMaterialBirth],
		["material birth blocks v1 establishment under user custody", testMaterialBirthBlocksV1Establishment],
		["v2 reservation survives publication and user custody", testV2EstablishmentBlocksMaterialBirth],
		["completed direct birth does not retain itself", testDirectBirthBecomesCollectibleAfterCompletion]
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