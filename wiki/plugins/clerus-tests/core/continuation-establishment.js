/*\
title: $:/plugins/clerus/tests/core/continuation-establishment.js
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

function fixture(tw, fail) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var target = "$:/clerus/jobs/v2-established-unique";
	var sequence = 0;
	var initialized = 0;

	function createRuntime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: function () {
				sequence++;
				return "establishment-generated-" +
					String(sequence).padStart(12, "0");
			},
			resolveExecutor: function (name) {
				assert(name === "initializer");

				return function (event, operational, incoming) {
					assert(event.type === "order");
					initialized++;

					if (fail) {
						throw new Error("Initializer rejected event");
					}

					incoming.get("contract").accept(
						"charter",
						{ phase: "initialized" }
					);

					incoming.move(
						"input",
						operational,
						"received"
					);
				};
			}
		});
	}

	var runtime = createRuntime();

	function work(id, eventId) {
		return {
			version: 2,
			id: id,
			checks: [],
			transitions: [],
			blocks: [],
			emits: [{
				id: eventId,
				event: {
					kind: "delivery",
					recipient: {
						title: target,
						executor: "initializer"
					},
					type: "order",
					establishing: true,
					registry: {
						contract: {
							form: "contract",
							executor: "initializer",
							temp: false,
							book: { purpose: "test" }
						},
						input: {
							form: "memo",
							data: 42
						}
					}
				}
			}]
		};
	}

	return {
		wiki: wiki,
		platform: platform,
		target: target,
		runtime: runtime,
		restart: createRuntime,
		work: work,
		initialized: function () {
			return initialized;
		}
	};
}

function start(f) {
	var title = f.runtime.continuations.accept(
		f.work(
			"establishment-work-000001",
			"establishment-event-00001"
		)
	);

	f.runtime.recover();
	return title;
}

function testEstablishment(tw) {
	var f = fixture(tw, false);
	var title = start(f);

	assert(!f.wiki.tiddlerExists(f.target));
	assert(f.initialized() === 0);

	f.runtime.drainFlows();

	assert(f.initialized() === 1);
	assert(!f.wiki.tiddlerExists(title));

	var job = f.wiki.getTiddler(f.target);
	var registry = JSON.parse(job.fields.text);

	assert(job.fields["clerus-executor"] === "initializer");
	assert(job.fields["clerus-custody"] === f.platform);
	assert(registry.charter.status.phase === "initialized");
	assert(registry.charter.book.purpose === "test");
	assert(registry.received.data === 42);
}

function testPausedEstablishmentKeepsReservation(tw) {
	var f = fixture(tw, true);
	var title = start(f);

	f.runtime.drainFlows();

	assert(f.initialized() === 1);
	assert(!f.wiki.tiddlerExists(f.target));

	var journal = f.wiki.getTiddler(title);
	var record = JSON.parse(journal.fields.text);
	var ids = Object.keys(record.events);

	assert(journal.fields["clerus-custody"] === "user");
	assert(ids.length === 1);
	assert(record.events[ids[0]].mode === "paused");
	assert(record.events[ids[0]].event.establishing);

	throws(function () {
		f.runtime.continuations.accept(
			f.work(
				"establishment-work-000002",
				"establishment-event-00002"
			)
		);
	}, "address is reserved");
}

function testAcceptedBirthRecoversWithoutInitializer(tw) {
	var f = fixture(tw, false);
	var title = start(f);
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.target && !injected) {
			injected = true;
			throw new Error("Interrupted after birth write");
		}

		return result;
	};

	try {
		f.runtime.drainFlows();
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(f.initialized() === 1);
	assert(f.wiki.tiddlerExists(f.target));

	var journal = f.wiki.getTiddler(title);
	var record = JSON.parse(journal.fields.text);

	assert(record.work);
	assert(Object.keys(record.events).length === 0);
	assert(record.work.transitions.some(function (effect) {
		return effect.title === f.target && effect.before === null;
	}));

	f.wiki.addTiddler(new tw.Tiddler(journal, {
		"clerus-custody": f.platform
	}));

	var restarted = f.restart();

	restarted.recover();
	restarted.drainFlows();

	assert(f.initialized() === 1);
	assert(!f.wiki.tiddlerExists(title));
}

exports.run = function (tw) {
	var cases = [
		["establishing event creates a persistent job", testEstablishment],
		["paused establishment preserves its reservation", testPausedEstablishmentKeepsReservation],
		["accepted birth resumes without initializer replay", testAcceptedBirthRecoversWithoutInitializer]
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