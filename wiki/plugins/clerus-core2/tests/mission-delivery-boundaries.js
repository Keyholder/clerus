/*\
title: $:/plugins/clerus/core2/tests/mission-delivery-boundaries.js
type: application/javascript
module-type: library
\*/

"use strict";

var Scheduler = require(
	"$:/plugins/clerus/core2/scheduler.js"
).Scheduler;

var Store = require("$:/plugins/clerus/core2/store.js").Store;

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

function fixture(tw, handlers) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/";

	var titles = {
		director: prefix + "boundary-director",
		worker: prefix + "boundary-worker",
		staff: prefix + "boundary-staff"
	};

	var project = "Core2 Delivery Boundaries Project";

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

	function write(name, registry) {
		registry.charter = {
			form: "charter",
			status: {}
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
		root: grant([], "10", {
			branch: "10/1",
			other: "10/2"
		}),
		branch: grant(["branch"], "10/1", {
			leaf: "10/1/1"
		}),
		other: grant(["other"], "10/2"),
		worker: titles.worker,
		staff: titles.staff
	});

	write("worker", {});

	write("staff", {
		mission: grant(["branch", "leaf"], "10/1/1")
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
				},
				other: {
					task: { name: "other" },
					parts: {}
				}
			}
		})
	}));

	function readJobs() {
		return Object.keys(titles).map(function (name) {
			var tiddler = wiki.getTiddler(titles[name]);

			return {
				title: titles[name],
				custody: tiddler.fields["clerus-custody"],
				registry: JSON.parse(tiddler.fields.text)
			};
		});
	}

	var scheduler = new Scheduler({
		platform: platform,

		store: new Store({
			wiki: wiki,
			Tiddler: tw.Tiddler
		}),

		readJobs: readJobs,

		resolveExecutor: function (name) {
			return handlers[name];
		}
	});

	return {
		wiki: wiki,
		titles: titles,
		scheduler: scheduler,
		readJobs: readJobs,

		activeStaff: function () {
			return missions.evaluate(readJobs()).active.some(
				function (entry) {
					return entry.title === titles.staff;
				}
			);
		},

		text: function (name) {
			return wiki.getTiddler(titles[name]).fields.text;
		}
	};
}

function testRevocationAfterSending(tw) {
	var received = false;
	var f;

	f = fixture(tw, {
		director: function (event, operational) {
			var outgoing = operational.outgoing();

			operational.move("branch", outgoing, "assignment");
			operational.get("worker").order(outgoing);

			// The message is accepted, but not delivered yet.
			assert(!received);

			operational.get("root").revokePart("branch");
		},

		worker: function (event, operational, incoming) {
			received = true;

			var assignment = incoming.get("assignment");

			assert(!assignment.inspect().active);

			throws(function () {
				assignment.task();
			});

			// Inactive assignments cannot be filed or forwarded.
			throws(function () {
				incoming.move(
					"assignment",
					operational,
					"mission"
				);
			});

			assert(incoming.keys().join(",") === "assignment");
			assert(operational.keys().join(",") === "charter");

			incoming.destroy("assignment");
		},

		staff: function () {}
	});

	var staffBefore = f.text("staff");

	var result = f.scheduler.dispatch(
		f.titles.director,
		{ type: "test" }
	);

	assert(received);
	assert(result.errors.length === 0);
	assert(result.skipped.length === 0);
	assert(result.delivered.length === 2);
	assert(f.text("staff") === staffBefore);
	assert(!f.activeStaff());
}

function testReportRejectsAnotherMission(tw) {
	var refused = false;
	var reports = 0;
	var f;

	f = fixture(tw, {
		director: function (event, operational, incoming) {
			if (event.type === "report") {
				reports++;
				return;
			}

			var outgoing = operational.outgoing();

			operational.move("branch", outgoing, "branch");
			operational.move("other", outgoing, "other");

			operational.get("worker").order(outgoing);
		},

		worker: function (event, operational, incoming) {
			if (event.type === "order") {
				incoming.move("branch", operational, "branch");
				incoming.move("other", operational, "other");
				return;
			}

			var outgoing = operational.outgoing();

			operational.move("other", outgoing, "foreign");

			throws(function () {
				operational.get("branch").report(outgoing);
			}, "only its addressing mission");

			refused = true;

			// Refusal did not consume the prepared registry.
			assert(outgoing.keys().join(",") === "foreign");
			assert(outgoing.get("foreign").inspect().active);

			outgoing.move("foreign", operational, "other");
		},

		staff: function () {}
	});

	var first = f.scheduler.dispatch(
		f.titles.director,
		{ type: "test" }
	);

	assert(first.errors.length === 0);

	var second = f.scheduler.dispatch(
		f.titles.worker,
		{ type: "attempt-report" }
	);

	assert(refused);
	assert(reports === 0);
	assert(second.errors.length === 0);
	assert(second.delivered.length === 1);
}

function testStaffTransfer(tw, copyStaff) {
	var f;

	f = fixture(tw, {
		director: function (event, operational) {
			var outgoing = operational.outgoing();

			operational.move("branch", outgoing, "assignment");

			if (copyStaff) {
				operational.copy("staff", outgoing, "staff");
			}

			operational.get("worker").order(outgoing);
		},

		worker: function (event, operational, incoming) {
			var assignment = incoming.get("assignment");

			assert(assignment.inspect().active);

			incoming.move(
				"assignment",
				operational,
				"mission"
			);

			/*
			A transactional staff title is not yet an
			organizational edge.
			*/
			assert(!f.activeStaff());

			if (copyStaff) {
				incoming.move("staff", operational, "staff");
				assert(f.activeStaff());
			}
		},

		staff: function () {}
	});

	assert(f.activeStaff());

	var before = f.text("staff");

	var result = f.scheduler.dispatch(
		f.titles.director,
		{ type: "test" }
	);

	assert(result.errors.length === 0);
	assert(result.skipped.length === 0);

	// Authority changed without rewriting the lower registry.
	assert(f.text("staff") === before);
	assert(f.activeStaff() === copyStaff);
}

function testStaffWithoutReference(tw) {
	testStaffTransfer(tw, false);
}

function testStaffWithReference(tw) {
	testStaffTransfer(tw, true);
}

exports.run = function (tw) {
	var cases = [
		["delivery boundaries: revocation does not cancel accepted delivery", testRevocationAfterSending],
		["delivery boundaries: report rejects a different assignment", testReportRejectsAnotherMission],
		["delivery boundaries: missing staff reference deactivates lower role", testStaffWithoutReference],
		["delivery boundaries: explicit staff reference restores lower authority", testStaffWithReference]
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