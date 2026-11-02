/*\
title: $:/plugins/clerus/core2/tests/assigned-establishment.js
type: application/javascript
module-type: library
\*/

"use strict";

var Scheduler = require(
	"$:/plugins/clerus/core2/scheduler.js"
).Scheduler;

var Store = require("$:/plugins/clerus/core2/store.js").Store;

var jobTitles = require(
	"$:/plugins/clerus/core2/job-titles.js"
);

var missions = require(
	"$:/plugins/clerus/core2/missions.js"
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

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function fixture(tw, settings, worker) {
	settings = settings || {};

	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/";
	var founder = prefix + "assigned-founder";
	var staff = prefix + "assigned-staff";
	var project = "Core2 Assigned Establishment Project";

	function grant(role, link, children) {
		return {
			form: "mission",
			project: project,
			role: role,
			link: link,
			issued: "0",
			children: children || {}
		};
	}

	var branch = grant(["branch"], "10/1", {
		leaf: "10/1/1"
	});

	var founderRegistry = {
		charter: {
			form: "charter",
			status: {}
		},
		root: grant([], "10", {
			branch: "10/1"
		}),
		branch: branch,
		alias: clone(branch),
		contract: {
			form: "contract",
			executor: "new-worker",
			temp: true,
			book: { instruction: "take responsibility" }
		},
		note: {
			form: "memo",
			data: { value: 42 }
		},
		staff: staff
	};

	function writeJob(title, executor, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(registry)
		}));
	}

	writeJob(founder, "founder", founderRegistry);

	writeJob(staff, "staff", {
		charter: {
			form: "charter",
			status: {}
		},
		mission: grant(
			["branch", "leaf"],
			"10/1/1"
		)
	});

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		text: JSON.stringify({
			task: {},
			parts: {
				branch: {
					task: { name: "branch task" },
					parts: {
						leaf: {
							task: { name: "leaf task" },
							parts: {}
						}
					}
				}
			}
		})
	}));

	function readJobs() {
		var jobs = [];

		wiki.each(function (tiddler, title) {
			if (!jobTitles.isJobTitle(title)) {
				return;
			}

			jobs.push({
				title: title,
				custody: tiddler.fields["clerus-custody"],
				registry: JSON.parse(tiddler.fields.text)
			});
		});

		return jobs;
	}

	var sequence = 0;
	var f;

	var scheduler = new Scheduler({
		platform: platform,

		store: new Store({
			wiki: wiki,
			Tiddler: tw.Tiddler
		}),

		newId: function () {
			sequence++;

			return "assigned-birth-" +
				String(sequence).padStart(8, "0");
		},

		readJobs: readJobs,

		resolveExecutor: function (name) {
			if (name === "founder") {
				return function (event, operational) {
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

					operational.move(
						"contract",
						outgoing,
						"contract"
					);

					operational.copy("note", outgoing, "note");

					if (settings.copyStaff) {
						operational.copy("staff", outgoing, "staff");
					}

					child.order(outgoing);
				};
			}

			if (name === "new-worker") {
				return function (event, operational, incoming) {
					worker(f, event, operational, incoming);
				};
			}

			if (name === "staff") {
				return function () {
					throw new Error(
						"Establishment must not invoke the lower executor"
					);
				};
			}
		}
	});

	f = {
		wiki: wiki,
		founder: founder,
		staff: staff,
		scheduler: scheduler,

		registry: function (title) {
			return JSON.parse(wiki.getTiddler(title).fields.text);
		},

		childTitle: function () {
			return f.registry(founder).child;
		},

		activeStaff: function () {
			return missions.evaluate(readJobs()).active.some(
				function (entry) {
					return entry.title === staff;
				}
			);
		}
	};

	return f;
}

function testAuthorityAppearsAfterAcceptance(tw) {
	var f = fixture(tw, {}, function (
		f,
		event,
		operational,
		incoming
	) {
		var assignment = incoming.get("assignment");

		assert(!f.wiki.getTiddler(event.title));
		assert(!assignment.inspect().active);

		throws(function () {
			incoming.move(
				"assignment",
				operational,
				"mission"
			);
		});

		assert(incoming.keys().includes("assignment"));

		incoming.get("contract").accept(
			"charter",
			{ phase: "starting" }
		);

		assert(operational.keys().join(",") === "charter");
		assert(assignment.inspect().active);
		assert(assignment.task().name === "branch task");

		incoming.move("assignment", operational, "mission");
		incoming.destroy("note");

		assert(operational.get("mission") === assignment);
	});

	var result = f.scheduler.dispatch(
		f.founder,
		{ type: "test" }
	);

    assert(
        result.errors.length === 0,
        "Establishment reaction failed: " +
            JSON.stringify(result.errors)
    );

	assert(result.skipped.length === 0);
	assert(result.delivered.length === 2);

	assert(!f.registry(f.founder).branch);
	assert(!f.registry(f.founder).alias);
	assert(f.registry(f.childTitle()).mission.link === "10/1");
}

function testExplicitAssignmentDestruction(tw) {
	var f = fixture(tw, {}, function (
		f,
		event,
		operational,
		incoming
	) {
		incoming.get("contract").accept("charter", {});

		var assignment = incoming.get("assignment");

		assert(assignment.inspect().active);

		incoming.destroy("assignment");
		incoming.destroy("note");

		throws(function () {
			assignment.inspect();
		}, "no longer available");

		assert(operational.keys().join(",") === "charter");
	});

	var result = f.scheduler.dispatch(
		f.founder,
		{ type: "test" }
	);

	assert(result.errors.length === 0);
	assert(Object.keys(f.registry(f.childTitle())).join(",") === "charter");
	assert(!f.activeStaff());
}

function testStaffTransfer(tw, copyStaff) {
	var f = fixture(tw, {
		copyStaff: copyStaff
	}, function (f, event, operational, incoming) {
		incoming.get("contract").accept("charter", {});

		incoming.move("assignment", operational, "mission");
		incoming.destroy("note");

		/*
		The child task is held, but the lower staff relationship
		has not yet been established by this new owner.
		*/
		assert(!f.activeStaff());

		if (copyStaff) {
			incoming.move("staff", operational, "staff");

			assert(f.activeStaff());
		}
	});

	assert(f.activeStaff());

	var staffBefore = f.wiki.getTiddler(f.staff).fields.text;

	var result = f.scheduler.dispatch(
		f.founder,
		{ type: "test" }
	);

	assert(result.errors.length === 0);
	assert(result.skipped.length === 0);
	assert(result.delivered.length === 2);

	assert(
		f.wiki.getTiddler(f.staff).fields.text === staffBefore
	);

	assert(f.activeStaff() === copyStaff);
}

function testStaffWithoutTitle(tw) {
	testStaffTransfer(tw, false);
}

function testStaffWithTitle(tw) {
	testStaffTransfer(tw, true);
}

exports.run = function (tw) {
	var cases = [
		["assigned establishment: acceptance precedes mission authority", testAuthorityAppearsAfterAcceptance],
		["assigned establishment: assignment may be explicitly destroyed", testExplicitAssignmentDestruction],
		["assigned establishment: missing staff title deactivates lower role", testStaffWithoutTitle],
		["assigned establishment: explicit staff reception preserves lower role", testStaffWithTitle]
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