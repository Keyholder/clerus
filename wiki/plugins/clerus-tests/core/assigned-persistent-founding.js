/*\
title: $:/plugins/clerus/tests/core/assigned-persistent-founding.js
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

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var founder = "$:/clerus/jobs/assigned-persistent-founder";
	var staff = "$:/clerus/jobs/assigned-persistent-staff";
	var project = "Core2 Assigned Persistent Founding Project";

	var sequence = 0;
	var calls = {
		founder: 0,
		initializer: 0
	};

	var branch = {
		form: "mission",
		project: project,
		role: ["branch"],
		link: "10/1",
		issued: "1",
		children: { leaf: "10/1/1" }
	};

	function write(title, executor, registry) {
		registry.charter = {
			form: "charter",
			status: {}
		};

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(registry)
		}));
	}

	write(founder, "founder", {
		root: {
			form: "mission",
			project: project,
			role: [],
			link: "10",
			issued: "1",
			children: { branch: "10/1" }
		},
		branch: branch,
		alias: clone(branch),
		staff: staff,
		contract: {
			form: "contract",
			executor: "initializer",
			temp: false,
			book: { instruction: "take branch" }
		}
	});

	write(staff, "staff", {
		mission: {
			form: "mission",
			project: project,
			role: ["branch", "leaf"],
			link: "10/1/1",
			issued: "0",
			children: {}
		}
	});

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		text: JSON.stringify({
			task: {},
			parts: {
				branch: {
					task: { name: "branch" },
					parts: {
						leaf: {
							task: { name: "leaf" },
							parts: {}
						}
					}
				}
			}
		})
	}));

	function registry(title) {
		return JSON.parse(wiki.getTiddler(title).fields.text);
	}

	function createRuntime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,

			newId: function () {
				sequence++;

				return "assigned-persistent-birth-" +
					String(sequence).padStart(8, "0");
			},

			resolveExecutor: function (name) {
				if (name === "founder") {
					return function (event, operational) {
						calls.founder++;

						var child = operational.get("charter").createTitle(
							"worker",
							operational,
							"child"
						);

						var outgoing = operational.outgoing();

						operational.move(
							"branch",
							outgoing,
							"assignment"
						);

						assert(!operational.keys().includes("alias"));

						operational.move(
							"contract",
							outgoing,
							"contract"
						);

						operational.copy("staff", outgoing, "staff");
						child.order(outgoing);
					};
				}

				if (name === "initializer") {
					return function (event, operational, incoming) {
						calls.initializer++;

						assert(!wiki.getTiddler(event.title));

						var assignment = incoming.get("assignment");

						assert(!assignment.inspect().active);

						var charter = incoming.get("contract").accept(
							"charter",
							{ phase: "starting" }
						);

						assert(!wiki.getTiddler(event.title));
						assert(assignment.inspect().active);
						assert(assignment.task().name === "branch");

						incoming.move(
							"assignment",
							operational,
							"mission"
						);

						incoming.move(
							"staff",
							operational,
							"staff"
						);

						charter.setStatus({ phase: "running" });
					};
				}

				if (name === "staff") {
					return function () {
						throw new Error(
							"Founding must not invoke lower staff"
						);
					};
				}
			}
		});
	}

	return {
		wiki: wiki,
		platform: platform,
		founder: founder,
		staff: staff,
		calls: calls,
		registry: registry,
		runtime: createRuntime(),
		createRuntime: createRuntime,

		childTitle: function (journal) {
			var owner = registry(founder);

			if (owner.child) {
				return owner.child;
			}

			var record = JSON.parse(
				wiki.getTiddler(journal).fields.text
			);

			assert(record.version === 2);
			assert(record.kind === "continuation");

			var events = Object.keys(record.events).map(
				function (id) {
					return record.events[id].event;
				}
			);

			if (record.work !== null) {
				events = events.concat(
					record.work.emits.map(function (effect) {
						return effect.event;
					})
				);
			}

			var founding = events.find(function (event) {
				return event.establishing === true;
			});

			assert(
				founding,
				"Accepted work lost its founding event"
			);

			return founding.recipient.title;
		}
	};
}

function verifyCompleted(f, runtime, journal, staffBefore) {
	var owner = f.registry(f.founder);
	var child = owner.child;

	assert(child);
	assert(!owner.contract);
	assert(!owner.branch);
	assert(!owner.alias);

	var registry = f.registry(child);

	assert(registry.charter.status.phase === "running");
	assert(
		registry.charter.book.instruction === "take branch"
	);
	assert(registry.mission.link === "10/1");
	assert(registry.staff === f.staff);

	assert(f.calls.founder === 1);
	assert(f.calls.initializer === 1);
	assert(!f.wiki.getTiddler(journal));

	assert(
		f.wiki.getTiddler(f.staff).fields.text === staffBefore
	);

	assert(runtime.inspect().missions.active.some(
		function (entry) {
			return entry.title === f.staff;
		}
	));
}

function testNormalFounding(tw) {
	var f = fixture(tw);
	var staffBefore = f.wiki.getTiddler(f.staff).fields.text;

	var result = f.runtime.dispatch(
		f.founder,
		{ type: "found" }
	);

	assert(result.status === "completed");
	assert(
		observation.attempts(result.flow).errors.length === 0
	);

	verifyCompleted(
		f,
		f.runtime,
		result.obligation,
		staffBefore
	);
}

function testInterruption(tw, point) {
	var f = fixture(tw);
	var staffBefore = f.wiki.getTiddler(f.staff).fields.text;
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var sourceWrite = effect.title === f.founder;

		var birthWrite =
			effect.before === null &&
			effect.after !== null &&
			effect.after["clerus-executor"] === "initializer";

		var pendingWrite = false;

		if (
			effect.after &&
			effect.after["clerus-wal-kind"] === "continuation"
		) {
			var body = JSON.parse(effect.after.text);

			pendingWrite =
				body.work === null &&
				Object.keys(body.events).some(function (id) {
					return (
						body.events[id].event.establishing === true
					);
				});
		}

		var matches =
			(point === "before-source" && sourceWrite) ||
			(point === "after-source" && sourceWrite) ||
			(point === "after-pending" && pendingWrite) ||
			(point === "before-birth" && birthWrite) ||
			(point === "after-birth" && birthWrite);

		if (!injected && matches) {
			injected = true;

			if (point.indexOf("after-") === 0) {
				originalApply.call(this, effect);
			}

			throw new Error("Injected interruption: " + point);
		}

		return originalApply.call(this, effect);
	};

	var result;

	try {
		result = f.runtime.dispatch(
			f.founder,
			{ type: "found" }
		);
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected, "Interruption point was not reached: " + point);

	var journal = result.obligation;

	assert(journal);
	assert(f.wiki.getTiddler(journal));
	assert(f.calls.founder === 1);

	var birthAttempted =
		point === "before-birth" ||
		point === "after-birth";

	assert(
		f.calls.initializer === (birthAttempted ? 1 : 0)
	);

	var child = f.childTitle(journal);

	assert(
		!!f.wiki.getTiddler(child) === (point === "after-birth")
	);

	assert(
		f.wiki.getTiddler(journal)
			.fields["clerus-custody"] === "user"
	);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(journal),
		{ "clerus-custody": f.platform }
	));

	var restarted = f.createRuntime();

	restarted.recover();

	// Recovery materializes chosen results but invokes no handler.
	assert(f.calls.founder === 1);
	assert(
		f.calls.initializer === (birthAttempted ? 1 : 0)
	);

	var delivered = restarted.drainFlows();

	assert(
		observation.attempts(delivered).errors.length === 0
	);
	assert(delivered.summary.materializations === 0);
	assert(delivered.summary.waiting.deliveries.ready === 0);
	assert(delivered.summary.waiting.deliveries.paused === 0);

	verifyCompleted(f, restarted, journal, staffBefore);
}

exports.run = function (tw) {
	var cases = [
		["assigned persistent founding: normal transfer preserves staff", function () {
			testNormalFounding(tw);
		}]
	];

	[
		"before-source",
		"after-source",
		"after-pending",
		"before-birth",
		"after-birth"
	].forEach(function (point) {
		cases.push([
			"assigned persistent founding: recovery " + point,
			function () {
				testInterruption(tw, point);
			}
		]);
	});

	var results = cases.map(function (item) {
		try {
			item[1]();

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