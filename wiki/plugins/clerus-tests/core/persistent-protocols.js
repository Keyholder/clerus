/*\
title: $:/plugins/clerus/tests/core/persistent-protocols.js
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

function fixture(tw, handlers, staffedTransfer) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";

	var titles = {
		director: "$:/clerus/jobs/protocol-director",
		manager: "$:/clerus/jobs/protocol-manager",
		worker: "$:/clerus/jobs/protocol-worker"
	};

	var project = "Core2 Persistent Protocol Project";

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

	var root = grant([], "10", {
		department: "10/1"
	});

	var department = grant(["department"], "10/1", {
		item: "10/1/1"
	});

	var item = grant(
		["department", "item"],
		"10/1/1"
	);

	function write(name, extra) {
		var registry = Object.assign({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			}
		}, extra);

		wiki.addTiddler(new tw.Tiddler({
			title: titles[name],
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": name,
			text: JSON.stringify(registry)
		}));
	}

	write("director", staffedTransfer ? {
		root: root,
		department: department,
		alias: clone(department),
		manager: titles.manager,
		worker: titles.worker
	} : {
		mission: root,
		subordinate: titles.manager
	});

	write("manager", staffedTransfer ? {} : {
		mission: department,
		subordinate: titles.worker
	});

	write("worker", {
		mission: item,
		evidence: {
			form: "memo",
			data: { value: 42 }
		}
	});

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		text: JSON.stringify({
			task: {},
			parts: {
				department: {
					task: { name: "department" },
					parts: {
						item: {
							task: { name: "item" },
							parts: {}
						}
					}
				}
			}
		})
	}));

	var sequence = 0;

	function createRuntime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,

			newId: function () {
				sequence++;

				return "persistent-protocol-" +
					String(sequence).padStart(10, "0");
			},

			resolveExecutor: function (name) {
				return handlers[name];
			}
		});
	}

	return {
		wiki: wiki,
		platform: platform,
		titles: titles,
		project: project,
		runtime: createRuntime(),
		createRuntime: createRuntime,

		registry: function (name) {
			return JSON.parse(
				wiki.getTiddler(titles[name]).fields.text
			);
		},

		flowTitles: function () {
			var result = [];

			wiki.each(function (tiddler, title) {
				var kind = tiddler.fields["clerus-wal-kind"];

				if (
					kind === "flow" ||
					kind === "continuation"
				) {
					result.push(title);
				}
			});

			return result.sort();
		}
	};
}

function testUpwardAndDownwardCascade(tw) {
	var trace = [];
	var journals = [];
	var f;

	function observeFlow() {
		var titles = f.flowTitles();

		assert(titles.length === 1);
		journals.push(titles[0]);
	}

	f = fixture(tw, {
		worker: function (event, operational, incoming) {
			if (event.type === "test") {
				trace.push("worker:report");

				var outgoing = operational.outgoing();

				operational.copy("evidence", outgoing, "result");
				operational.get("mission").report(outgoing);

				operational.get("charter").setStatus({
					phase: "reported"
				});

				return;
			}

			assert(event.type === "order");
			observeFlow();
			trace.push("worker:order");

			assert(incoming.get("instruction").data().value === 42);

			incoming.move(
				"instruction",
				operational,
				"received"
			);
		},

		manager: function (event, operational, incoming) {
			observeFlow();

			if (event.type === "report") {
				trace.push("manager:report");

				assert(event.project === f.project);
				assert(event.role.join("/") === "department/item");
				assert(
					f.registry("worker").charter.status.phase ===
						"reported"
				);

				var report = incoming.outgoing();

				incoming.move("result", report, "result");
				operational.get("mission").report(report);

				return;
			}

			assert(event.type === "order");
			trace.push("manager:order");

			var order = incoming.outgoing();

			incoming.move("instruction", order, "instruction");
			operational.get("subordinate").order(order);
		},

		director: function (event, operational, incoming) {
			assert(event.type === "report");
			observeFlow();
			trace.push("director:report");

			assert(event.role.join("/") === "department");
			assert(!("source" in event));

			var outgoing = incoming.outgoing();

			incoming.move("result", outgoing, "instruction");
			operational.get("subordinate").order(outgoing);
		}
	}, false);

	var result = f.runtime.dispatch(
		f.titles.worker,
		{ type: "test" }
	);

	assert(result.status === "completed");
	assert(observation.attempts(result.flow).errors.length === 0);
	assert(result.flow.continuations.every(function (pass) {
		return pass.errors.length === 0;
	}));
	assert(result.flow.remaining === 0);

	assert(
		trace.join(",") ===
			"worker:report,manager:report,director:report," +
			"manager:order,worker:order"
	);

	assert(journals.length === 4);
	assert(new Set(journals).size === 1);
	assert(journals[0] === result.obligation);

	assert(f.flowTitles().length === 0);
	assert(f.registry("worker").received.data.value === 42);

	assert(f.registry("director").mission);
	assert(f.registry("manager").mission);
	assert(f.registry("worker").mission);
}

function transferHandlers(state) {
	return {
		director: function (event, operational, incoming) {
			if (event.type === "report") {
				state.returned++;

				incoming.move(
					"assignment",
					operational,
					"returned"
				);

				incoming.move(
					"staff",
					operational,
					"returnedStaff"
				);

				return;
			}

			state.director++;

			var outgoing = operational.outgoing();

			operational.move(
				"department",
				outgoing,
				"assignment"
			);

			assert(!operational.keys().includes("alias"));

			operational.copy("worker", outgoing, "staff");
			operational.get("manager").order(outgoing);
		},

		manager: function (event, operational, incoming) {
			if (event.type === "order") {
				state.manager++;

				var assignment = incoming.get("assignment");

				assert(assignment.inspect().active);
				assert(assignment.task().name === "department");

				// No automatic filing before the handler.
				assert(operational.keys().join(",") === "charter");

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

				return;
			}

			assert(event.type === "return");

			var mission = operational.get("mission");
			var outgoing = operational.outgoing();

			operational.move(
				"mission",
				outgoing,
				"assignment"
			);

			operational.copy("staff", outgoing, "staff");
			mission.report(outgoing);
		},

		worker: function () {
			throw new Error(
				"Staff must not be invoked by assignment transfer"
			);
		}
	};
}

function workerIsActive(runtime, title) {
	return runtime.inspect().missions.active.some(
		function (entry) {
			return entry.title === title;
		}
	);
}

function testStaffedAssignmentRoundTrip(tw) {
	var state = {
		director: 0,
		manager: 0,
		returned: 0
	};

	var f = fixture(tw, transferHandlers(state), true);
	var staffBefore = f.wiki.getTiddler(f.titles.worker).fields.text;

	assert(workerIsActive(f.runtime, f.titles.worker));

	var first = f.runtime.dispatch(
		f.titles.director,
		{ type: "transfer" }
	);

	assert(first.status === "completed");
	assert(observation.attempts(first.flow).errors.length === 0);
	assert(first.flow.continuations.every(function (pass) {
		return pass.errors.length === 0;
	}));
	assert(workerIsActive(f.runtime, f.titles.worker));

	assert(!f.registry("director").department);
	assert(!f.registry("director").alias);
	assert(f.registry("manager").mission.link === "10/1");

	var returned = f.runtime.dispatch(
		f.titles.manager,
		{ type: "return" }
	);

	assert(returned.status === "completed");
	assert(observation.attempts(returned.flow).errors.length === 0);
	assert(returned.flow.continuations.every(function (pass) {
		return pass.errors.length === 0;
	}));
	assert(state.returned === 1);
	assert(f.registry("director").returned.link === "10/1");
	assert(!f.registry("manager").mission);
	assert(workerIsActive(f.runtime, f.titles.worker));

	assert(
		f.wiki.getTiddler(f.titles.worker).fields.text ===
			staffBefore
	);
}

function testInterruptedAssignmentReception(tw) {
	var state = {
		director: 0,
		manager: 0,
		returned: 0
	};

	var f = fixture(tw, transferHandlers(state), true);
	var staffBefore = f.wiki.getTiddler(f.titles.worker).fields.text;
	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (
			effect.title === f.titles.manager &&
			!injected
		) {
			injected = true;
			throw new Error("Interrupted assignment reception");
		}

		return result;
	};

	var result;

	try {
		result = f.runtime.dispatch(
			f.titles.director,
			{ type: "transfer" }
		);
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);

	var errors = observation.attempts(result.flow).errors;

	assert(errors.length === 1);
	assert(errors[0].result.phase === "materialization");

	assert(state.director === 1);
	assert(state.manager === 1);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(result.obligation),
		{ "clerus-custody": f.platform }
	));

	var restarted = f.createRuntime();

	restarted.recover();

	assert(state.director === 1);
	assert(state.manager === 1);
	assert(!f.wiki.getTiddler(result.obligation));

	assert(f.registry("manager").mission.link === "10/1");
	assert(workerIsActive(restarted, f.titles.worker));

	assert(
		f.wiki.getTiddler(f.titles.worker).fields.text ===
			staffBefore
	);
}

exports.run = function (tw) {
	var cases = [
		["persistent protocols: reports and orders share one flow", testUpwardAndDownwardCascade],
		["persistent protocols: staffed assignment returns without lower writes", testStaffedAssignmentRoundTrip],
		["persistent protocols: interrupted reception resumes without handler replay", testInterruptedAssignmentReception]
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