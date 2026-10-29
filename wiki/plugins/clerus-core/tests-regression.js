/*\
title: $:/plugins/clerus/core/tests-regression.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var Dispatcher = require("$:/plugins/clerus/core/dispatcher.js").Dispatcher;
var contexts = require("$:/plugins/clerus/core/context.js");
var basicDocuments = require("$:/plugins/clerus/core/documents-basic.js");
var hierarchy = require("$:/plugins/clerus/core/hierarchy.js");
var missions = require("$:/plugins/clerus/core/missions.js");
var roles = require("$:/plugins/clerus/core/roles.js");
var projectWriter =
	require("$:/plugins/clerus/core/project-writer.js");
var createWriter =
	require("$:/plugins/clerus/core/ephemeral-writer.js").createWriter;
var documentFlow =
	require("$:/plugins/clerus/core/document-flow.js");
var filterDocument =
	require("$:/plugins/clerus/core/document-filter.js");
var filterViews =
	require("$:/plugins/clerus/core/filter-view.js");
var filterWriter =
	require("$:/plugins/clerus/core/filter-writer.js");
var warrantDocument =
	require("$:/plugins/clerus/core/document-warrant.js");
var tiddlerWriter =
	require("$:/plugins/clerus/core/tiddler-writer.js");
var tiddlerViews =
	require("$:/plugins/clerus/core/tiddler-view.js");
var tiddlerCreation =
	require("$:/plugins/clerus/core/tiddler-creation.js");
var effects = require("$:/plugins/clerus/core/effects.js");
var lifecycle = require("$:/plugins/clerus/core/lifecycle.js");
var workPlans =
	require("$:/plugins/clerus/core/work-plan.js");
var Wal = require("$:/plugins/clerus/core/wal.js").Wal;
var messageEffects =
	require("$:/plugins/clerus/core/message-effect.js");
var FlowWal = require("$:/plugins/clerus/core/flow-wal.js").FlowWal;
var deferredEffects =
	require("$:/plugins/clerus/core/deferred-effect.js");
var deferredWal =
	require("$:/plugins/clerus/core/deferred-wal.js");
var appointmentEffects =
	require("$:/plugins/clerus/core/appointment-effect.js");
var missionLinks =
	require("$:/plugins/clerus/core/mission-links.js");
var missionIssuance =
	require("$:/plugins/clerus/core/mission-issuance.js");
var StatusObserver =
	require("$:/plugins/clerus/core/status-observer.js").StatusObserver;
var agentCallDocument =
	require("$:/plugins/clerus/core/document-agent-call.js");
var openRouterTransport =
	require("$:/plugins/clerus/core/openrouter-transport.js");
var agentSessionDocument =
	require("$:/plugins/clerus/core/document-agent-session.js");
var agentWikiTools =
	require("$:/plugins/clerus/core/agent-wiki-tools.js");
var warrantMission =
	require("$:/plugins/clerus/core/warrant-mission.js");
var operationStates =
	require("$:/plugins/clerus/core/state.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function assertThrows(fn, fragment) {
	var caught = null;

	try {
		fn();
	} catch (error) {
		caught = error;
	}

	assert(caught !== null, "Expected an exception");

	if (fragment) {
		assert(
			String(caught.message).indexOf(fragment) !== -1,
			"Unexpected exception: " + caught.message
		);
	}
}

function moduleSource(executors) {
	return {
		forEachModuleOfType: function (type, callback) {
			if (type === "clerus-document") {
				callback("test-documents", basicDocuments);
				callback("test-filter-document", filterDocument);
				callback("test-warrant-document", warrantDocument);
				callback("test-agent-call-document", agentCallDocument);
				callback(
					"test-agent-session-document",
					agentSessionDocument
				);
			}

			if (type === "clerus-executor") {
				executors.forEach(function (executor) {
					callback("test-executor/" + executor.name, executor);
				});
			}
		}
	};
}

function waitFor(predicate, timeout) {
	var deadline = Date.now() + timeout;

	return new Promise(function (resolve, reject) {
		function check() {
			try {
				if (predicate()) {
					resolve();
					return;
				}
			} catch (error) {
				reject(error);
				return;
			}

			if (Date.now() >= deadline) {
				reject(new Error("Timed out waiting for the runtime"));
				return;
			}

			setTimeout(check, 5);
		}

		check();
	});
}

function testContext() {
	var forms = contexts.loadForms(moduleSource([]));
	var writes = [];

	var scope = contexts.openContext({
		note: {
			form: "memo",
			data: { value: 1 }
		}
	}, forms, {
		replace: function (key, document) {
			writes.push({
				key: key,
				document: document
			});
		}
	});

	try {
		var note = scope.context.get("note");
		var read = note.data();

		read.value = 99;

		assert(note.data().value === 1, "Read leaked a mutable reference");

		var next = { value: 2 };

		note.setData(next);
		next.value = 99;

		assert(note.data().value === 2, "Write retained the caller's object");
		assert(writes.length === 1, "Expected exactly one write");
		assert(writes[0].document.data.value === 2, "Incorrect written data");

		scope.close();

		assertThrows(function () {
			note.data();
		}, "closed");

		assertThrows(function () {
			note.setData({ value: 3 });
		}, "closed");
	} finally {
		scope.close();
	}
}

function testHierarchy() {
	var A = "$:/clerus/jobs/test-a";
	var B = "$:/clerus/jobs/test-b";
	var E = "$:/temp/clerus/jobs/browser/test-e";

	var cyclic = hierarchy.audit([
		{ title: A, persistent: true, registry: { child: B } },
		{ title: B, persistent: true, registry: { child: A } }
	]);

	assert(!cyclic.valid, "Cycle was accepted");
	assert(
		cyclic.violations.some(function (violation) {
			return violation.type === "cycle";
		}),
		"Missing cycle diagnostic"
	);

	var forbidden = hierarchy.audit([
		{ title: E, persistent: false, registry: { child: A } }
	]);

	assert(!forbidden.valid, "Ephemeral superior was accepted");
	assert(forbidden.unresolved.length === 1, "Missing unresolved reference");
}

async function testOrders(tw, duplicate) {
	var wiki = new tw.Wiki();
	var trace = [];
	var dismissalWriteRefused = false;
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/temp/clerus/jobs/" + platform + "/test-founder";
	var childTitle = title + "/worker";

	function founder(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var child = operational.get("charter").createTitle(
			"worker",
			"subordinate"
		);

		child.order("mandate");
		child.order({ note: "sourceNote" });

		if (duplicate) {
			child.order({ note: "sourceNote" });
		}
	}

	function receiver(event, operational, incoming) {
		if (event.type === "dismissed") {
			trace.push("dismissed");

			try {
				operational.get("charter").setStatus({
					phase: "forbidden"
				});
			} catch (error) {
				dismissalWriteRefused =
					String(error.message).indexOf("read-only") !== -1;
			}

			return;
		}

		if (event.type !== "order") {
			return;
		}

		if (!incoming) {
			trace.push("institution");
			return;
		}

		trace.push("message");

		incoming.get("note").file("receivedNote");

		operational.get("charter").setStatus({
			phase: "received"
		});
	}

	var executors = [
		{
			name: "test-founder",
			browser: founder,
			node: founder
		},
		{
			name: "test-receiver",
			browser: receiver,
			node: receiver
		}
	];

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	var dispatcher = new Dispatcher({
		runtime: runtime,
		modules: moduleSource(executors),
		Tiddler: tw.Tiddler
	});

	runtime.start();
	dispatcher.start();

	try {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "test-founder",
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: { phase: "created" }
				},
				mandate: {
					form: "contract",
					temp: true,
					executor: "test-receiver"
				},
				sourceNote: {
					form: "memo",
					data: { value: 42 }
				}
			})
		}));

		await waitFor(function () {
			var child = wiki.getTiddler(childTitle);

			if (!child) {
				return false;
			}

			var registry = JSON.parse(child.fields.text);

			return duplicate
				? child.fields["clerus-custody"] === "user"
				: registry.charter.status.phase === "received";
		}, 2000);

		var parent = JSON.parse(wiki.getTiddler(title).fields.text);
		var child = wiki.getTiddler(childTitle);
		var childRegistry = JSON.parse(child.fields.text);

		assert(
			!Object.prototype.hasOwnProperty.call(parent, "mandate"),
			"Contract remained with the founder"
		);
		assert(parent.sourceNote.data.value === 42, "Source memo was lost");
		assert(
			childRegistry.receivedNote.data.value === 42,
			"Received memo was not filed"
		);

		if (duplicate) {
			assert(
				trace.join(",") === "institution,message,message,dismissed",
				"Incorrect failure sequence: " + trace.join(",")
			);
			assert(
				childRegistry.charter.status.previous.phase === "received",
				"Earlier ephemeral effects were not preserved"
			);
			assert(
				dispatcher.inspect().errors.some(function (error) {
					return error.title === childTitle &&
						error.message.indexOf("already exists") !== -1;
				}),
				"Missing duplicate filing diagnostic"
			);
			assert(
				dismissalWriteRefused,
				"Dismissed executor was not refused a write"
			);
		} else {
			assert(
				trace.join(",") === "institution,message",
				"Incorrect delivery sequence: " + trace.join(",")
			);
			assert(
				dispatcher.inspect().errors.length === 0,
				"Unexpected executor errors"
			);
		}
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function linkedMissionFactory(project, paths) {
	var registry = {
		root: {
			form: "mission",
			project: project,
			role: [],
			link: "10",
			issued: "0",
			children: {}
		}
	};
	var keys = new Map();
	var sequence = 0;

	keys.set(JSON.stringify([]), "root");

	function ensure(role) {
		var identity = JSON.stringify(role);

		if (keys.has(identity)) {
			return keys.get(identity);
		}

		var parentKey = ensure(role.slice(0, -1));
		var destinationKey = "mission-" + (++sequence);
		var result = missionIssuance.issue(
			registry,
			parentKey,
			role[role.length - 1],
			destinationKey
		);

		registry = result.registry;
		keys.set(identity, destinationKey);

		return destinationKey;
	}

	(paths || []).forEach(ensure);

	return function (role) {
		var key = keys.get(JSON.stringify(role));

		if (key === undefined) {
			throw new Error(
				"Mission role is absent from the fixture: " +
				JSON.stringify(role)
			);
		}

		return JSON.parse(JSON.stringify(registry[key]));
	};
}

function testMissionAudit() {
	var project = "Test Project";
	var A = "$:/clerus/jobs/director-a";
	var B = "$:/clerus/jobs/director-b";
	var createMission = linkedMissionFactory(project, []);

	function mission() {
		return createMission([]);
	}

	var aliases = missions.audit([
		{
			title: A,
			registry: {
				first: mission(),
				second: mission()
			}
		}
	]);

	assert(aliases.valid, "Aliases within one job caused a conflict");
	assert(aliases.conflicts.length === 0, "Unexpected alias conflict");

	var conflict = missions.audit([
		{
			title: A,
			registry: { mission: mission() }
		},
		{
			title: B,
			registry: { mission: mission() }
		}
	]);

	assert(!conflict.valid, "Two holders were accepted");
	assert(conflict.conflicts.length === 1, "Expected one conflicting role");
	assert(
		conflict.conflicts[0].holders.length === 2,
		"Both holders must appear in the diagnostic"
	);
}

async function testMissionLifecycle(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var projectTitle = "Clerus Test Project";
	var mission = linkedMissionFactory(projectTitle, []);
	var directorTitle =
		"$:/temp/clerus/jobs/" + platform + "/test-director";
	var trace = [];

	function director(event, operational) {
		if (
			event.type !== "ready" &&
			!(
				event.type === "document-change" &&
				event.key === "mission"
			)
		) {
			return;
		}

		var mission = operational.get("mission");
		var view = mission.inspect();

		trace.push({
			type: event.type,
			readable: view.readable,
			task: view.task,
			reason: view.reason
		});

		if (view.readable) {
			// Mutating a returned task must not modify the project.
			var task = mission.task();

			task.message = "executor-local mutation";
		}

		operational.get("charter").setStatus({
			phase: view.readable ? "assigned" : "blocked",
			task: view.task,
			reason: view.reason
		});
	}

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	var dispatcher = new Dispatcher({
		runtime: runtime,
		modules: moduleSource([
			{
				name: "test-director",
				browser: director,
				node: director
			}
		]),
		Tiddler: tw.Tiddler
	});

	function writeProject(message) {
		wiki.addTiddler(new tw.Tiddler({
			title: projectTitle,
			type: "application/json",
			"clerus-custody": "user",
			text: JSON.stringify({
				task: { message: message },
				parts: {}
			})
		}));
	}

	function status() {
		var tiddler = wiki.getTiddler(directorTitle);

		return tiddler
			? JSON.parse(tiddler.fields.text).charter.status
			: null;
	}

	runtime.start();
	dispatcher.start();

	try {
		writeProject("initial");

		wiki.addTiddler(new tw.Tiddler({
			title: directorTitle,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "test-director",
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: { phase: "created" }
				},
				mission: mission([])
			})
		}));

		await waitFor(function () {
			var current = status();

			return current &&
				current.phase === "assigned" &&
				current.task.message === "initial";
		}, 2000);

		assert(
			JSON.parse(wiki.getTiddler(projectTitle).fields.text)
				.task.message === "initial",
			"Task read leaked a mutable reference"
		);

		writeProject("updated");

		await waitFor(function () {
			var current = status();

			return current &&
				current.phase === "assigned" &&
				current.task.message === "updated";
		}, 2000);

		wiki.deleteTiddler(projectTitle);

		await waitFor(function () {
			var current = status();

			return current && current.phase === "blocked";
		}, 2000);

		assert(
			status().reason === "Project does not exist",
			"Missing project diagnostic"
		);

		// The mission survives project disappearance at this stage.
		assert(
			JSON.parse(wiki.getTiddler(directorTitle).fields.text)
				.mission.form === "mission",
			"Mission was silently removed"
		);

		writeProject("restored");

		await waitFor(function () {
			var current = status();

			return current &&
				current.phase === "assigned" &&
				current.task.message === "restored";
		}, 2000);

		assert(trace.length === 4, "Unexpected number of mission reactions");
		assert(trace[0].type === "ready", "Missing initial activation");

		assert(
			trace.slice(1).every(function (event) {
				return event.type === "document-change";
			}),
			"Project changes caused reactivation instead of document events"
		);

		assert(
			dispatcher.inspect().errors.length === 0,
			"Unexpected director errors"
		);
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testMissionConflictRead(tw) {
	var wiki = new tw.Wiki();
	var project = "Conflicting Project";
	var A = "$:/clerus/jobs/director-a";
	var B = "$:/clerus/jobs/director-b";
	var document = linkedMissionFactory(project, [])([]);

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		text: JSON.stringify({
			task: { message: "available only to one holder" },
			parts: {}
		})
	}));

	var jobs = [
		{ title: A, registry: { mission: document } },
		{ title: B, registry: { mission: document } }
	];

	var first = missions.read(wiki, jobs, A, document);
	var second = missions.read(wiki, jobs, B, document);

	assert(!first.readable, "First conflicting holder received the task");
	assert(!second.readable, "Second conflicting holder received the task");

	assert(
		first.reason === "ambiguous-holder",
		"Wrong conflict reason"
	);

	// Removing the other holder restores access without changing the project.
	var repaired = missions.read(wiki, jobs.slice(0, 1), A, document);

	assert(repaired.readable, "Access did not recover after conflict repair");
}

function testNestedMissions(tw) {
	var wiki = new tw.Wiki();
	var project = "Nested Test Project";
	var director = "$:/clerus/jobs/nested-director";
	var worker = "$:/clerus/jobs/nested-worker";

	var mission = linkedMissionFactory(project, [
		["section"],
		["section", "item"]
	]);

	var root = mission([]);
	var nested = mission(["section", "item"]);

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		text: JSON.stringify({
			task: { name: "root" },
			parts: {
				section: {
					task: { name: "section" },
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

	var jobs = [
		{
			title: director,
			registry: {
				root: root,
				section: mission(["section"]),
				subordinate: worker
			}
		},
		{
			title: worker,
			registry: {
				item: nested
			}
		}
	];

	assert(missions.audit(jobs).valid, "Valid nested assignments rejected");

	var view = missions.read(wiki, jobs, worker, nested);

	assert(view.readable, "Nested task was not readable");
	assert(view.task.name === "item", "Wrong nested task resolved");

	// Removing the direct-superior edge invalidates the child assignment.
	delete jobs[0].registry.subordinate;

	assert(
		missions.audit(jobs).valid,
		"Inactive assignments were treated as malformed"
	);

	view = missions.read(wiki, jobs, worker, nested);

	assert(!view.active, "Assignment remained active without a superior");
	assert(!view.readable, "Task remained readable without a superior");
	assert(
		view.reason === "invalid-subordination",
		"Wrong superior diagnostic"
	);

	// The same job may hold both the parent and child assignments.
	jobs[1].registry.section = jobs[0].registry.section;
	delete jobs[0].registry.section;

	// The worker's section assignment still needs its root superior.
	jobs[0].registry.subordinate = worker;

	assert(
		missions.audit(jobs).valid,
		"Same-holder parent assignment was rejected"
	);

	// A root director is not enough: the immediate parent must be assigned.
	delete jobs[1].registry.section;

	view = missions.read(wiki, jobs, worker, nested);

	assert(!view.readable, "Missing immediate parent was accepted");
	assert(
		view.reason === "inactive-parent",
		"Wrong missing-parent diagnostic"
	);
}

function testRolePaths() {
	assert(roles.stringify([]) === "", "Wrong root serialization");
	assert(roles.parse("").length === 0, "Wrong root parsing");

	var role = ["analysis", "обзор литературы", "v1.0"];
	var path = roles.stringify(role);

	assert(
		JSON.stringify(roles.parse(path)) === JSON.stringify(role),
		"Unicode role did not round-trip"
	);

	assert(roles.stringify(["100%"]) === "100%25", "Percent was not escaped");
	assert(roles.stringify(["a!b"]) === "a%21b", "Non-unreserved literal escaped incorrectly");

	["", ".", "..", "a/b", "a\\b", "a?b", "a#b", "\u0000", "\uD800"]
		.forEach(function (segment) {
			assert(!roles.isSegment(segment), "Invalid segment accepted");
		});

	["/a", "a/", "a//b", "%41", "%2F", "%", "%ff"]
		.forEach(function (path) {
			assertThrows(function () {
				roles.parse(path);
			});
		});

	assert(
		!missions.isMission({
			form: "mission",
			project: "Project",
			role: [""],
			link: "10/1",
			issued: "0",
			children: {}
		}),
		"Mission accepted an empty role segment"
	);
}

function testProjectWrites(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var projectTitle = "Writable Test Project";
	var jobTitle = "$:/temp/clerus/jobs/" + platform + "/project-writer";

	var document = linkedMissionFactory(projectTitle, [])([]);

	wiki.addTiddler(new tw.Tiddler({
		title: projectTitle,
		type: "application/json",
		"clerus-custody": "user",
		caption: "Must survive project writes",
		text: JSON.stringify({
			task: { name: "root" },
			parts: {}
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: jobTitle,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "test-writer",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "created" }
			},
			mission: document
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	function create(segment, task) {
		projectWriter.createPart({
			runtime: runtime,
			Tiddler: tw.Tiddler,
			job: runtime.inspect().jobs[0],
			key: "mission",
			document: document,
			segment: segment,
			task: task
		});
	}

	runtime.start();

	try {
		var before = wiki.getTiddler(projectTitle).fields.text;

		assertThrows(function () {
			create("child", { name: "child" });
		}, "not owned");

		assert(
			wiki.getTiddler(projectTitle).fields.text === before,
			"Unauthorized write changed the project"
		);

		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(projectTitle),
			{ "clerus-custody": platform }
		));

		var task = { name: "child" };

		create("child", task);
		task.name = "caller mutation";

		var project = wiki.getTiddler(projectTitle);
		var tree = JSON.parse(project.fields.text);

		assert(tree.parts.child.task.name === "child", "Task copy was lost");
		assert(
			Object.keys(tree.parts.child.parts).length === 0,
			"New child must have empty parts"
		);
		assert(
			project.fields.caption === "Must survive project writes",
			"Unrelated project fields were lost"
		);

		assertThrows(function () {
			create("child", { name: "replacement" });
		}, "already exists");

		assertThrows(function () {
			create("a/b", {});
		}, "segment");

		assertThrows(function () {
			create("invalid-json", { value: NaN });
		}, "non-finite");

		create("__proto__", { name: "safe property" });

		tree = JSON.parse(wiki.getTiddler(projectTitle).fields.text);

		assert(
			Object.prototype.hasOwnProperty.call(tree.parts, "__proto__"),
			"Special property name was not preserved"
		);
	} finally {
		runtime.stop();
	}
}

async function testStaffTransfer(tw, includeTitle) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/staff-test/";
	var director = prefix + "a-director";
	var former = prefix + "b-former";
	var worker = prefix + "c-worker";
	var leaf = prefix + "d-leaf";
	var replacement = director + "/replacement";
	var project = "Staff Transfer Project";

	var trace = [];
	var transferredFormRevoked = false;
	var replacementOrderCount = 0;

	var mission = linkedMissionFactory(project, [
		["department"],
		["department", "worker"],
		["department", "worker", "item"]
	]);

	function founder(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var assignment = operational.get("department");

		var recipient = operational.get("charter").createTitle(
			"replacement",
			"replacementTitle"
		);

		recipient.order(
			"mandate",
			"department",
			includeTitle ? { worker: "knownWorker" } : {}
		);

		try {
			assignment.inspect();
		} catch (error) {
			transferredFormRevoked =
				String(error.message).indexOf("no longer") !== -1;
		}

		operational.get("charter").setStatus({
			phase: "delegated"
		});
	}

	function receiver(event, operational, incoming) {
		if (event.type !== "order") {
			return;
		}

		replacementOrderCount++;

		// Establishment has already transformed the incoming mandate.
		var view = operational.get("mission").inspect();

		operational.get("charter").setStatus({
			phase: view.readable ? "assigned" : "blocked",
			task: view.task,
			reason: view.reason
		});

		trace.push({
			title: event.title,
			type: event.type,
			hasIncomingContext: !!incoming
		});
	}

	function employee(event) {
		if (event.type === "detached") {
			trace.push({
				title: event.title,
				type: event.type,
				roles: event.roles
			});
		}
	}

	var modules = moduleSource([
		{
			name: "staff-founder",
			browser: founder,
			node: founder
		},
		{
			name: "staff-receiver",
			browser: receiver,
			node: receiver
		},
		{
			name: "staff-employee",
			browser: employee,
			node: employee
		}
	]);

	function addJob(title, executor, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(Object.assign({
				charter: {
					form: "charter",
					status: { phase: "created" }
				}
			}, registry))
		}));
	}

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: { name: "root" },
			parts: {
				department: {
					task: { name: "department" },
					parts: {
						worker: {
							task: { name: "worker" },
							parts: {
								item: {
									task: { name: "item" },
									parts: {}
								}
							}
						}
					}
				}
			}
		})
	}));

	var projectText = wiki.getTiddler(project).fields.text;

	addJob(director, "staff-founder", {
		mission: mission([]),
		former: former,
		knownWorker: worker,
		mandate: {
			form: "contract",
			temp: true,
			executor: "staff-receiver",
			book: { purpose: "Receive a staffed department" }
		},
		department: mission(["department"])
	});

	addJob(former, "staff-employee", {
		worker: worker
	});

	addJob(worker, "staff-employee", {
		mission: mission(["department", "worker"]),
		subordinate: leaf,
		note: { form: "memo", data: "worker evidence" }
	});

	addJob(leaf, "staff-employee", {
		mission: mission(["department", "worker", "item"]),
		note: { form: "memo", data: "leaf evidence" }
	});

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	var dispatcher = new Dispatcher({
		runtime: runtime,
		modules: modules,
		Tiddler: tw.Tiddler
	});

	function registry(title) {
		var tiddler = wiki.getTiddler(title);

		return tiddler ? JSON.parse(tiddler.fields.text) : null;
	}

	runtime.start();

	try {
		assert(runtime.inspect().missions.valid, "Initial assignments are invalid");
		assert(runtime.inspect().hierarchy.valid, "Initial hierarchy is invalid");

		var workerBefore = effects.capture(wiki.getTiddler(worker));
		var leafBefore = effects.capture(wiki.getTiddler(leaf));

		dispatcher.start();

		await waitFor(function () {
			var received = registry(replacement);

			return received &&
				received.charter.status.phase === "assigned";
		}, 2000);

		var parent = registry(director);
		var previous = registry(former);
		var received = registry(replacement);
		var workerRegistry = registry(worker);
		var leafRegistry = registry(leaf);

		assert(transferredFormRevoked, "Transferred form remained usable");
		assert(!parent.department, "Transferred assignment remained with sender");
		assert(!parent.mandate, "Consumed mandate remained with sender");
		assert(parent.mission.role.length === 0, "Sender lost its parent role");
		assert(parent.knownWorker === worker, "Copied title disappeared from sender");

		assert(!previous.mission, "Former holder retained the role");
		assert(!previous.alias, "Former holder retained an assignment alias");

		assert(
			received.mission.role.join("/") === "department",
			"Recipient received the wrong role"
		);
		assert(
			received.charter.book.purpose === "Receive a staffed department",
			"Contract book was not preserved"
		);
		assert(
			received.charter.status.task.name === "department",
			"Recipient could not read its task"
		);
		assert(replacementOrderCount === 1, "Wrong number of establishing orders");

		if (includeTitle) {
			assert(received.worker === worker, "Recipient did not receive the title");
			assert(workerRegistry.mission, "Known worker was detached");
			assert(leafRegistry.mission, "Legal deeper assignment was detached");
		} else {
			assert(!received.worker, "Unselected title reached the recipient");
			assert(workerRegistry.mission, "Worker document was physically removed");
			assert(leafRegistry.mission, "Descendant document was physically removed");
		}

		assert(workerRegistry.note.data === "worker evidence", "Worker memo was lost");
		assert(leafRegistry.note.data === "leaf evidence", "Leaf memo was lost");

		assert(
			wiki.getTiddler(worker).fields["clerus-custody"] === platform &&
			wiki.getTiddler(leaf).fields["clerus-custody"] === platform,
			"Detachment revoked employee custody"
		);

		assert(workerRegistry.mission, "Worker document was removed");
		assert(leafRegistry.mission, "Descendant document was removed");

		var jobs = runtime.inspect().jobs;

		assert(
			missions.read(
				wiki, jobs, worker, workerRegistry.mission
			).active === includeTitle,
			"Wrong worker authority after transfer"
		);
		assert(
			missions.read(
				wiki, jobs, leaf, leafRegistry.mission
			).active === includeTitle,
			"Wrong descendant authority after transfer"
		);

		assert(
			wiki.getTiddler(project).fields.text === projectText,
			"Assignment transfer modified the project tree"
		);
		assert(runtime.inspect().missions.valid, "Final assignments are invalid");
		assert(runtime.inspect().hierarchy.valid, "Final hierarchy is invalid");
		assert(dispatcher.inspect().errors.length === 0, "Unexpected executor errors");

		assert(
			JSON.stringify(effects.capture(wiki.getTiddler(worker))) ===
				JSON.stringify(workerBefore),
			"Report rewrote the worker"
		);
		assert(
			JSON.stringify(effects.capture(wiki.getTiddler(leaf))) ===
				JSON.stringify(leafBefore),
			"Report rewrote the descendant"
		);
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

async function testStaffReport(tw, includeTitles) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/report-test/";
	var director = prefix + "a-director";
	var staffing = prefix + "b-staffing";
	var worker = prefix + "c-worker";
	var leaf = prefix + "d-leaf";
	var project = "Staff Report Project";

	var immediateReportRefused = false;
	var refusalPreservedState = false;
	var missionFormRevoked = false;
	var aliasFormRevoked = false;
	var tickCount = 0;
	var reportCount = 0;
	var received = null;
	var detachedEmployees = new Set();
	var trace = [];

	var mission = linkedMissionFactory(project, [
		["department"],
		["department", "worker"],
		["department", "worker", "item"]
	]);

	function registry(title) {
		var tiddler = wiki.getTiddler(title);

		return tiddler ? JSON.parse(tiddler.fields.text) : null;
	}

	function directorReact(event, operational, incoming) {
		if (event.type === "ready") {
			operational.get("staffing").order({
				instruction: "instruction"
			});

			return;
		}

		if (event.type !== "report") {
			return;
		}

		reportCount++;
		trace.push("report");

		received = {
			role: event.role.slice(),
			incomingKeys: incoming.keys(),
			incomingTask: incoming.get("returned").task(),
			operationalTask: operational.get("returned").task()
		};
	}

	function staffingReact(event, operational, incoming) {
		if (event.type === "order") {
			trace.push("order");

			var beforeSource = wiki.getTiddler(staffing).fields.text;
			var beforeDirector = wiki.getTiddler(director).fields.text;

			try {
				operational.get("mission").report("premature", {
					worker: "knownWorker"
				});
			} catch (error) {
				immediateReportRefused =
					String(error.message).indexOf(
						"Cannot report while reacting to an order"
					) !== -1;
			}

			refusalPreservedState =
				wiki.getTiddler(staffing).fields.text === beforeSource &&
				wiki.getTiddler(director).fields.text === beforeDirector;

			// Inspect the incoming instruction without filing it.
			if (incoming.get("instruction").data().action !== "return") {
				throw new Error("Wrong staffing instruction");
			}

			// Repeated requests must coalesce into one tick.
			operational.get("charter").defer();
			operational.get("charter").defer();
			return;
		}

		if (event.type !== "tick") {
			return;
		}

		tickCount++;
		trace.push("tick");

		var assignment = operational.get("mission");
		var alias = operational.get("alias");

		assignment.report(
			"returned",
			includeTitles ? { worker: "knownWorker" } : {}
		);

		try {
			assignment.inspect();
		} catch (error) {
			missionFormRevoked =
				String(error.message).indexOf("no longer") !== -1;
		}

		try {
			alias.inspect();
		} catch (error) {
			aliasFormRevoked =
				String(error.message).indexOf("no longer") !== -1;
		}

		operational.get("charter").setStatus({
			phase: "staffing-complete"
		});
	}

	function employeeReact(event) {
		if (event.type === "detached") {
			detachedEmployees.add(event.title);
		}
	}

	function addJob(title, executor, fields) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(Object.assign({
				charter: {
					form: "charter",
					status: { phase: "created" }
				}
			}, fields))
		}));
	}

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: { name: "root" },
			parts: {
				department: {
					task: { name: "department" },
					parts: {
						worker: {
							task: { name: "worker" },
							parts: {
								item: {
									task: { name: "item" },
									parts: {}
								}
							}
						}
					}
				}
			}
		})
	}));

	var projectText = wiki.getTiddler(project).fields.text;

	addJob(director, "report-director", {
		mission: mission([]),
		staffing: staffing,
		instruction: {
			form: "memo",
			data: { action: "return" }
		}
	});

	addJob(staffing, "report-staffing", {
		mission: mission(["department"]),
		alias: mission(["department"]),
		knownWorker: worker
	});

	addJob(worker, "report-employee", {
		mission: mission(["department", "worker"]),
		subordinate: leaf,
		note: { form: "memo", data: "worker evidence" }
	});

	addJob(leaf, "report-employee", {
		mission: mission(["department", "worker", "item"]),
		note: { form: "memo", data: "leaf evidence" }
	});

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	var dispatcher = new Dispatcher({
		runtime: runtime,
		modules: moduleSource([
			{
				name: "report-director",
				browser: directorReact,
				node: directorReact
			},
			{
				name: "report-staffing",
				browser: staffingReact,
				node: staffingReact
			},
			{
				name: "report-employee",
				browser: employeeReact,
				node: employeeReact
			}
		]),
		Tiddler: tw.Tiddler
	});

	runtime.start();

	try {
		assert(runtime.inspect().missions.valid, "Initial missions are invalid");
		assert(runtime.inspect().hierarchy.valid, "Initial hierarchy is invalid");

		var workerBefore = effects.capture(wiki.getTiddler(worker));
		var leafBefore = effects.capture(wiki.getTiddler(leaf));

		dispatcher.start();

		await waitFor(function () {
			return reportCount === 1;
		}, 2000);

		var parentRegistry = registry(director);
		var sourceRegistry = registry(staffing);
		var workerRegistry = registry(worker);
		var leafRegistry = registry(leaf);

		assert(immediateReportRefused, "Order reaction was allowed to report");
		assert(refusalPreservedState, "Refused report changed authoritative state");
		assert(tickCount === 1, "Deferred requests were not coalesced");
		assert(trace.join(",") === "order,tick,report", "Wrong event sequence");

		assert(missionFormRevoked, "Transferred mission form remained usable");
		assert(aliasFormRevoked, "Transferred alias form remained usable");
		assert(!sourceRegistry.mission, "Source retained the mission");
		assert(!sourceRegistry.alias, "Source retained a mission alias");
		assert(
			sourceRegistry.charter.status.phase === "staffing-complete",
			"Source writer failed after reporting"
		);
		assert(
			wiki.getTiddler(staffing).fields["clerus-custody"] === platform,
			"Reporting unexpectedly dismissed the source"
		);

		assert(parentRegistry.returned, "Superior did not receive the assignment");
		assert(
			received.role.join("/") === "department",
			"Report had the wrong role signature"
		);
		assert(received.incomingTask.name === "department", "Incoming mission unreadable");
		assert(
			received.operationalTask.name === "department",
			"Received mission was not filed before the reaction"
		);
		assert(
			parentRegistry.instruction.data.action === "return",
			"Copied instruction disappeared from its sender"
		);
		assert(
			sourceRegistry.knownWorker === worker,
			"Copied title disappeared from its sender"
		);

		if (includeTitles) {
			assert(parentRegistry.worker === worker, "Superior did not receive the title");
			assert(workerRegistry.mission, "Worker assignment was not preserved");
			assert(leafRegistry.mission, "Deeper assignment was not preserved");
			assert(detachedEmployees.size === 0, "Preserved employees were notified");

			assert(
				received.incomingKeys.indexOf("worker") !== -1,
				"Copied title was absent from the incoming context"
			);
		} else {
			assert(!parentRegistry.worker, "Unselected title reached the superior");
		}

		assert(workerRegistry.mission, "Worker document was physically removed");
		assert(leafRegistry.mission, "Descendant document was physically removed");

		var jobs = runtime.inspect().jobs;

		assert(
			missions.read(
				wiki, jobs, worker, workerRegistry.mission
			).active === includeTitles,
			"Wrong worker authority after report"
		);
		assert(
			missions.read(
				wiki, jobs, leaf, leafRegistry.mission
			).active === includeTitles,
			"Wrong descendant authority after report"
		);

		assert(workerRegistry.note.data === "worker evidence", "Worker memo was lost");
		assert(leafRegistry.note.data === "leaf evidence", "Leaf memo was lost");
		assert(
			wiki.getTiddler(project).fields.text === projectText,
			"Report changed the project"
		);
		assert(runtime.inspect().missions.valid, "Final missions are invalid");
		assert(runtime.inspect().hierarchy.valid, "Final hierarchy is invalid");
		assert(dispatcher.inspect().errors.length === 0, "Unexpected executor errors");
		assert(dispatcher.deferred.size === 0, "Deferred timer was not released");
		assert(
			JSON.stringify(effects.capture(wiki.getTiddler(worker))) ===
				JSON.stringify(workerBefore),
			"Report rewrote the worker"
		);
		assert(
			JSON.stringify(effects.capture(wiki.getTiddler(leaf))) ===
				JSON.stringify(leafBefore),
			"Report rewrote the descendant"
		);
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testDocumentFlow() {
	var rules = documentFlow.loadRules(moduleSource([]));

	var memo = documentFlow.prepare(
		{
			note: {
				form: "memo",
				data: { value: 1 }
			}
		},
		{ type: "order", establishing: false },
		rules
	);

	assert(memo.entries[0].transfer === "copy", "Memo is not copyable");
	assert(Object.keys(memo.automatic).length === 0, "Memo was auto-filed");
	assert(memo.explicit.note.data.value === 1, "Memo was not explicitly received");

	var appointment = documentFlow.prepare(
		{
			charter: {
				form: "contract",
				temp: true,
				executor: "test",
				book: { instruction: "work" }
			}
		},
		{ type: "order", establishing: true },
		rules
	);

	assert(
		appointment.entries[0].transfer === "move",
		"Contract was treated as a copy"
	);
	assert(
		appointment.automatic.charter.form === "charter",
		"Contract was not transformed"
	);
	assert(
		appointment.automatic.charter.book.instruction === "work",
		"Contract book was lost"
	);

	assertThrows(function () {
		documentFlow.prepare(
			{ charter: { form: "charter", status: null } },
			{ type: "order", establishing: false },
			rules
		);
	}, "cannot be sent");

	assertThrows(function () {
		documentFlow.prepare(
			{ mandate: { form: "contract", executor: "test" } },
			{ type: "report", establishing: false },
			rules
		);
	}, "cannot be sent");

	assertThrows(function () {
		documentFlow.prepare(
			{},
			{ type: "order", establishing: true },
			rules
		);
	}, "exactly one contract");
}

async function testMemoReport(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/memo-report/";
	var director = prefix + "director";
	var worker = prefix + "worker";
	var project = "Memo Report Project";

	var refusedInOrder = false;
	var explicitlyReceived = false;
	var assignmentStillUsable = false;
	var reportRole = null;

	var mission = linkedMissionFactory(project, [["worker"]]);

	function parent(event, operational, incoming) {
		if (event.type === "ready") {
			operational.get("worker").order({});
			return;
		}

		if (event.type !== "report") {
			return;
		}

		reportRole = event.role.slice();

		explicitlyReceived =
			operational.keys().indexOf("note") === -1 &&
			operational.keys().indexOf("receivedNote") === -1;

		var filed = incoming.get("note").file("receivedNote");

		operational.get("charter").setStatus({
			phase: "received",
			data: filed.data()
		});
	}

	function subordinate(event, operational) {
		if (event.type === "order") {
			try {
				operational.get("mission").report({
					note: "workingNote"
				});
			} catch (error) {
				refusedInOrder =
					String(error.message).indexOf(
						"Cannot report while reacting to an order"
					) !== -1;
			}

			operational.get("charter").defer();
			return;
		}

		if (event.type !== "tick") {
			return;
		}

		var assignment = operational.get("mission");

		assignment.report({
			note: "workingNote"
		});

		assignmentStillUsable = assignment.inspect().readable;

		operational.get("charter").setStatus({
			phase: "reported"
		});
	}

	function addJob(title, executor, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(Object.assign({
				charter: {
					form: "charter",
					status: { phase: "created" }
				}
			}, registry))
		}));
	}

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		text: JSON.stringify({
			task: {},
			parts: {
				worker: {
					task: { name: "worker" },
					parts: {}
				}
			}
		})
	}));

	addJob(director, "memo-report-parent", {
		mission: mission([]),
		worker: worker
	});

	addJob(worker, "memo-report-worker", {
		mission: mission(["worker"]),
		workingNote: {
			form: "memo",
			data: { result: 42 }
		}
	});

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	var dispatcher = new Dispatcher({
		runtime: runtime,
		modules: moduleSource([
			{
				name: "memo-report-parent",
				browser: parent,
				node: parent
			},
			{
				name: "memo-report-worker",
				browser: subordinate,
				node: subordinate
			}
		]),
		Tiddler: tw.Tiddler
	});

	function registry(title) {
		return JSON.parse(wiki.getTiddler(title).fields.text);
	}

	runtime.start();

	try {
		dispatcher.start();

		await waitFor(function () {
			return registry(director).charter.status.phase === "received";
		}, 2000);

		var source = registry(worker);
		var recipient = registry(director);

		assert(refusedInOrder, "Memo report was permitted inside an order reaction");
		assert(explicitlyReceived, "Memo was automatically filed");
		assert(assignmentStillUsable, "Reporting revoked the addressing mission");

		assert(source.mission, "Sender lost its assignment");
		assert(source.workingNote.data.result === 42, "Sender lost its memo");
		assert(recipient.receivedNote.data.result === 42, "Recipient did not file the memo");
		assert(reportRole.join("/") === "worker", "Wrong report signature");

		assert(runtime.inspect().missions.valid, "Assignments became invalid");
		assert(dispatcher.inspect().errors.length === 0, "Unexpected executor errors");
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

async function testOrdinaryTiddlerObservation(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "Observed Document";
	var observerTitle =
		"$:/temp/clerus/jobs/" + platform + "/ordinary-observer";

	var trace = [];
	var oldForm = null;
	var fieldsAreCopies = true;

	function react(event, operational) {
		if (
			event.type !== "ready" &&
			!(
				event.type === "document-change" &&
				event.key === "document"
			)
		) {
			return;
		}

		var document = operational.get("document");
		var view = document.inspect();

		trace.push({
			type: event.type,
			exists: view.exists,
			text: view.exists ? document.text() : null
		});

		if (view.exists) {
			view.fields.text = "executor-local mutation";

			fieldsAreCopies = fieldsAreCopies &&
				document.text() !== "executor-local mutation";
		}

		oldForm = document;

		operational.get("charter").setStatus({
			observations: trace.length
		});
	}

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	var dispatcher = new Dispatcher({
		runtime: runtime,
		modules: moduleSource([
			{
				name: "ordinary-observer",
				browser: react,
				node: react
			}
		]),
		Tiddler: tw.Tiddler
	});

	function write(text) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "text/plain",
			caption: "Observed",
			text: text
		}));
	}

	async function expectCount(count) {
		await waitFor(function () {
			return trace.length >= count;
		}, 2000);

		assert(trace.length === count, "Unexpected observation count");
	}

	runtime.start();
	dispatcher.start();

	try {
		wiki.addTiddler(new tw.Tiddler({
			title: observerTitle,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "ordinary-observer",
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: {}
				},
				document: title
			})
		}));

		await expectCount(1);
		assert(!trace[0].exists, "Missing document appeared to exist");

		write("created");
		await expectCount(2);

		write("updated");
		await expectCount(3);

		wiki.deleteTiddler(title);
		await expectCount(4);

		write("restored");
		await expectCount(5);

		assert(
			trace.map(function (event) {
				return event.text;
			}).join("|") === "|created|updated||restored",
			"Wrong observed document states"
		);
		assert(trace[0].type === "ready", "Initial activation missing");
		assert(
			trace.slice(1).every(function (event) {
				return event.type === "document-change";
			}),
			"Document changes caused reactivation"
		);

		assert(fieldsAreCopies, "Field inspection leaked mutable references");

		assertThrows(function () {
			oldForm.text();
		}, "closed");

		assert(
			wiki.getTiddler(title).fields.text === "restored",
			"Executor mutated the authoritative document"
		);
		assert(dispatcher.inspect().errors.length === 0, "Unexpected observer errors");
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testFilterTitleIssuance(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var jobTitle = "$:/temp/clerus/jobs/" + platform + "/filter-test";
	var target = "Filter Candidate";
	var excluded = "Unselected Document";
	var document = {
		form: "filter",
		filter: "[tag[clerus-selection]]"
	};

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		tags: ["clerus-selection"],
		text: "Selected content"
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: excluded,
		text: "Not selected"
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: "$:/test/hidden-system-target",
		tags: ["clerus-selection"],
		text: "Must not be issued"
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: jobTitle,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: {}
			},
			selection: document
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	runtime.start();

	try {
		var source = runtime.inspect().jobs.find(function (job) {
			return job.title === jobTitle;
		});

		var writer = createWriter({
			wiki: wiki,
			job: source,
			platform: platform,
			Tiddler: tw.Tiddler
		});

		var scope = contexts.openContext(
			source.registry,
			contexts.loadForms(moduleSource([])),
			{
				filterTitles: function (filter) {
					return filterViews.titles(wiki, filter);
				},

				readTiddler: function (title) {
					return {
						exists: !!wiki.getTiddler(title),
						fields: { text: wiki.getTiddler(title).fields.text }
					};
				},

				issueTitle: function (key, filter, title, destinationKey) {
					filterWriter.issueTitle({
						runtime: runtime,
						job: source,
						key: key,
						document: filter,
						title: title,
						destinationKey: destinationKey,
						replace: writer
					});
				}
			}
		);

		try {
			var selection = scope.context.get("selection");
			var titles = selection.titles();

			assert(titles.length === 1 && titles[0] === target, "Wrong permitted output");

			assertThrows(function () {
				selection.file(excluded, "excluded");
			}, "not in");

			// A previously read result must not authorize later issuance.
			wiki.addTiddler(new tw.Tiddler(
				wiki.getTiddler(target),
				{ tags: [] }
			));

			assertThrows(function () {
				selection.file(target, "stale");
			}, "not in");

			wiki.addTiddler(new tw.Tiddler(
				wiki.getTiddler(target),
				{ tags: ["clerus-selection"] }
			));

			var issued = selection.file(target, "selected");

			assert(issued.text() === "Selected content", "Issued title is not usable");

			var registry = JSON.parse(wiki.getTiddler(jobTitle).fields.text);

			assert(registry.selected === target, "Issued title was not materialized");
			assert(!registry.excluded && !registry.stale, "Failed issuance left documents");

			// Removing membership does not revoke an already issued document.
			wiki.addTiddler(new tw.Tiddler(
				wiki.getTiddler(target),
				{ tags: [] }
			));

			assert(issued.text() === "Selected content", "Membership removal revoked title");

			scope.close();

			assertThrows(function () {
				selection.titles();
			}, "closed");

			assertThrows(function () {
				issued.text();
			}, "closed");
		} finally {
			scope.close();
		}
	} finally {
		runtime.stop();
	}
}

function testWarrantWrites(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var jobTitle = "$:/temp/clerus/jobs/" + platform + "/write-test";
	var title = "Writable Document";
	var warrant = {
		form: "warrant",
		filter: "[tag[clerus-writable]]",
		operations: ["patch", "delete"],
		fields: ["text", "caption"]
	};

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		"clerus-custody": platform,
		tags: ["clerus-writable"],
		caption: "Remove me",
		text: "Initial"
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: jobTitle,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "test",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			document: title,
			permission: warrant,
			patchOnly: Object.assign({}, warrant, {
				operations: ["patch"]
			})
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	runtime.start();

	try {
		var source = runtime.inspect().jobs.find(function (job) {
			return job.title === jobTitle;
		});

		var scope = contexts.openContext(
			source.registry,
			contexts.loadForms(moduleSource([])),
			{
				readTiddler: function (target) {
					return tiddlerViews.read(wiki, target);
				},

				writeTiddler: function (
					documentKey, target, warrantKey, permission, operation, patch
				) {
					tiddlerWriter.write({
						runtime: runtime,
						Tiddler: tw.Tiddler,
						job: source,
						documentKey: documentKey,
						title: target,
						warrantKey: warrantKey,
						warrant: permission,
						operation: operation,
						patch: patch
					});
				}
			}
		);

		try {
			var document = scope.context.get("document");

			document.patch("permission", {
				set: { text: "Updated" },
				remove: ["caption"]
			});

			assert(document.text() === "Updated", "Allowed write failed");
			assert(document.field("caption") === undefined, "Field removal failed");

			assertThrows(function () {
				document.patch("permission", {
					set: { tags: "other" }
				});
			}, "does not allow field");

			assertThrows(function () {
				document.patch("permission", {
					set: { "clerus-custody": "user" }
				});
			}, "Protected");

			assertThrows(function () {
				document.delete("patchOnly");
			}, "does not allow operation");

			wiki.addTiddler(new tw.Tiddler(
				wiki.getTiddler(title),
				{ "clerus-custody": "user" }
			));

			assertThrows(function () {
				document.patch("permission", { set: { text: "Forbidden" } });
			}, "not owned");

			wiki.addTiddler(new tw.Tiddler(
				wiki.getTiddler(title),
				{
					"clerus-custody": platform,
					tags: []
				}
			));

			assertThrows(function () {
				document.patch("permission", { set: { text: "Forbidden" } });
			}, "does not cover");

			wiki.addTiddler(new tw.Tiddler(
				wiki.getTiddler(title),
				{ tags: ["clerus-writable"] }
			));

			document.delete("permission");

			assert(!document.inspect().exists, "Allowed deletion failed");
			assert(
				JSON.parse(wiki.getTiddler(jobTitle).fields.text).document === title,
				"Deletion removed the title document"
			);
		} finally {
			scope.close();
		}
	} finally {
		runtime.stop();
	}
}

function testTemplateCreation(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var jobTitle = "$:/temp/clerus/jobs/" + platform + "/creation-test";

	var warrant = {
		form: "warrant",
		filter: "[tag[clerus-generated]]",
		operations: ["create", "patch"],
		fields: ["text"],
		templates: {
			report: {
				title: "Clerus Reports/{{name}}",
				parameters: {
					name: "segment",
					body: "string"
				},
				fields: {
					type: "text/plain",
					tags: "clerus-generated",
					text: "{{body}}"
				}
			}
		}
	};

	wiki.addTiddler(new tw.Tiddler({
		title: jobTitle,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "test",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			permission: warrant
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	runtime.start();

	try {
		var source = runtime.inspect().jobs.find(function (job) {
			return job.title === jobTitle;
		});

		var writer = createWriter({
			wiki: wiki,
			job: source,
			platform: platform,
			Tiddler: tw.Tiddler
		});

		var scope = contexts.openContext(
			source.registry,
			contexts.loadForms(moduleSource([])),
			{
				readTiddler: function (title) {
					return tiddlerViews.read(wiki, title);
				},

				createTiddler: function (
					warrantKey, permission, templateName, parameters, destinationKey
				) {
					return tiddlerCreation.create({
						runtime: runtime,
						Tiddler: tw.Tiddler,
						job: source,
						warrantKey: warrantKey,
						warrant: permission,
						templateName: templateName,
						parameters: parameters,
						destinationKey: destinationKey,
						replace: writer
					});
				}
			}
		);

		try {
			var permission = scope.context.get("permission");

			assertThrows(function () {
				permission.create(
					"report",
					{ name: "a/b", body: "Forbidden" },
					"invalid"
				);
			}, "segment");

			assertThrows(function () {
				permission.create(
					"report",
					{ name: "extra", body: "Content", arbitrary: "field" },
					"extra"
				);
			}, "Unexpected");

			var document = permission.create(
				"report",
				{ name: "First report", body: "{{not-expanded}}" },
				"created"
			);

			assert(
				document.text() === "{{not-expanded}}",
				"Parameter content was recursively interpreted"
			);

			var target = wiki.getTiddler("Clerus Reports/First report");

			assert(target.fields["clerus-custody"] === platform, "Wrong custody");
			assert(target.fields.type === "text/plain", "Template type was lost");
			assert(
				target.fields.tags.indexOf("clerus-generated") !== -1,
				"Template tags were lost"
			);

			assertThrows(function () {
				permission.create(
					"report",
					{ name: "First report", body: "Overwrite" },
					"duplicate"
				);
			}, "already exists");

			var registry = JSON.parse(wiki.getTiddler(jobTitle).fields.text);

			assert(
				registry.created === "Clerus Reports/First report",
				"Created title was not filed"
			);
			assert(
				!registry.invalid && !registry.extra && !registry.duplicate,
				"Failed creation left title documents"
			);
		} finally {
			scope.close();
		}
	} finally {
		runtime.stop();
	}
}

function testEffectMaterialization(tw) {
	var wiki = new tw.Wiki();
	var title = "Effect Target";
	var writes = 0;
	var originalAdd = wiki.addTiddler.bind(wiki);

	wiki.addTiddler = function (tiddler) {
		writes++;
		return originalAdd(tiddler);
	};

	var create = effects.put(
		null,
		new tw.Tiddler({
			title: title,
			type: "text/plain",
			tags: ["first", "two words"],
			text: "Created"
		})
	);

	// Replay the serialized form rather than the original JS object.
	var serialized = JSON.parse(JSON.stringify(create));

	assert(
		effects.apply(wiki, tw.Tiddler, serialized) === "applied",
		"Creation effect was not applied"
	);
	assert(
		effects.apply(wiki, tw.Tiddler, serialized) === "already-applied",
		"Repeated creation was not recognized"
	);
	assert(writes === 1, "Replay wrote the tiddler again");

	assert(
		wiki.getTiddler(title).fields.tags.indexOf("two words") !== -1,
		"Typed fields did not survive serialization"
	);

	var current = wiki.getTiddler(title);
	var update = effects.put(
		current,
		new tw.Tiddler(current, { text: "Updated" })
	);

	effects.apply(wiki, tw.Tiddler, JSON.parse(JSON.stringify(update)));

	assert(wiki.getTiddler(title).fields.text === "Updated", "Update failed");

	// An intervening write must not be overwritten by replay.
	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(title),
		{ text: "External change" }
	));

	assertThrows(function () {
		effects.apply(wiki, tw.Tiddler, update);
	}, "precondition");

	assert(
		wiki.getTiddler(title).fields.text === "External change",
		"Stale effect overwrote external state"
	);

	var deletion = effects.remove(wiki.getTiddler(title));

	assert(
		effects.apply(wiki, tw.Tiddler, deletion) === "applied",
		"Deletion failed"
	);
	assert(
		effects.apply(wiki, tw.Tiddler, deletion) === "already-applied",
		"Repeated deletion failed"
	);

	// Reuse of the title must not permit deleting a different state.
	wiki.addTiddler(new tw.Tiddler({
		title: title,
		text: "New object"
	}));

	assertThrows(function () {
		effects.apply(wiki, tw.Tiddler, deletion);
	}, "precondition");

	assert(wiki.tiddlerExists(title), "Stale deletion removed a new object");
}

function testLifecycleFieldPreservation(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/temp/clerus/jobs/" + platform + "/metadata-test";

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "test",
		caption: "Preserve caption",
		tags: ["first", "two words"],
		created: new Date("2026-01-02T03:04:05Z"),
		"custom-field": "Preserve custom field",
		text: JSON.stringify({
			charter: {
				form: "charter",
				book: { instruction: "Preserve book" },
				status: { phase: "working" }
			},
			note: {
				form: "memo",
				data: { preserved: true }
			}
		})
	}));

	var before = effects.capture(wiki.getTiddler(title));

	lifecycle.dismissEphemeral({
		wiki: wiki,
		platform: platform,
		Tiddler: tw.Tiddler,
		job: {
			title: title,
			persistent: false,
			executor: "test"
		},
		error: {
			name: "Error",
			message: "Test failure",
			stack: null
		}
	});

	var after = effects.capture(wiki.getTiddler(title));

	Object.keys(before).forEach(function (field) {
		if (field !== "text" && field !== "clerus-custody") {
			assert(
				after[field] === before[field],
				"Lifecycle transition changed unrelated field: " + field
			);
		}
	});

	assert(
		Object.keys(after).length === Object.keys(before).length,
		"Lifecycle transition added or removed unrelated fields"
	);
	assert(after["clerus-custody"] === "user", "Custody transition failed");

	var registry = JSON.parse(after.text);

	assert(registry.charter.status.phase === "dismissed", "Dismissal status missing");
	assert(
		registry.charter.status.previous.phase === "working",
		"Previous status was lost"
	);
	assert(
		registry.charter.book.instruction === "Preserve book",
		"Book was changed"
	);
	assert(registry.note.data.preserved, "Unrelated document was changed");
}

function testWorkPlan(tw) {
	var wiki = new tw.Wiki();

	wiki.addTiddler(new tw.Tiddler({
		title: "Plan A",
		text: "Initial",
		caption: "Preserved"
	}));

	function open() {
		return new workPlans.WorkPlan({
			wiki: wiki,
			Wiki: tw.Wiki,
			Tiddler: tw.Tiddler
		});
	}

	var plan = open();

	plan.patch("Plan A", { text: "First" });
	plan.patch("Plan A", { text: "Final" });
	plan.put({ title: "Plan B", text: "Created" });

	assert(
		plan.view.getTiddler("Plan A").fields.text === "Final",
		"Plan did not read its own writes"
	);
	assert(
		wiki.getTiddler("Plan A").fields.text === "Initial",
		"Planning changed the real wiki"
	);
	assert(!wiki.tiddlerExists("Plan B"), "Creation escaped the plan");

	var exposed = plan.view.getTiddler("Plan A");

	assertThrows(function () {
		exposed.fields.text = "Unregistered mutation";
	});

	assert(
		plan.view.getTiddler("Plan A").fields.text === "Final",
		"Plan view changed after an attempted external mutation"
	);

	var another = plan.view.getTiddler("Plan A");

	assert(
		exposed !== another && exposed.fields !== another.fields,
		"Plan view reused an exposed tiddler or fields object"
	);

	var serialized = plan.export();

	assert(serialized.effects.length === 2, "Repeated target was not folded");

	plan.commit();

	assert(wiki.getTiddler("Plan A").fields.text === "Final", "Commit failed");
	assert(wiki.getTiddler("Plan A").fields.caption === "Preserved", "Field was lost");
	assert(wiki.getTiddler("Plan B").fields.text === "Created", "Creation failed");

	assertThrows(function () {
		plan.patch("Plan A", { text: "Too late" });
	}, "not open");

	var replay = workPlans.materialize(
		wiki,
		tw.Tiddler,
		JSON.parse(JSON.stringify(serialized))
	);

	assert(
		replay.every(function (result) {
			return result === "already-applied";
		}),
		"Compiled plan could not be replayed"
	);

	var aborted = open();

	aborted.patch("Plan A", { text: "Discarded" });
	aborted.abort();

	assert(wiki.getTiddler("Plan A").fields.text === "Final", "Abort changed the wiki");
	assertThrows(function () {
		aborted.export();
	}, "aborted");

	var transient = open();

	transient.put({ title: "Transient", text: "Temporary" });
	transient.remove("Transient");

	assert(
		transient.export().effects.length === 0,
		"Create/delete pair left an official effect"
	);

	transient.abort();
}

function testWorkPlanPreflight(tw) {
	var wiki = new tw.Wiki();

	wiki.addTiddler(new tw.Tiddler({ title: "First", text: "Original" }));
	wiki.addTiddler(new tw.Tiddler({ title: "Second", text: "Original" }));

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	plan.patch("First", { text: "Planned" });
	plan.patch("Second", { text: "Planned" });

	wiki.addTiddler(new tw.Tiddler({
		title: "Second",
		text: "External"
	}));

	assertThrows(function () {
		plan.commit();
	}, "precondition");

	assert(
		wiki.getTiddler("First").fields.text === "Original",
		"Preflight failure allowed an earlier write"
	);
	assert(
		wiki.getTiddler("Second").fields.text === "External",
		"Plan overwrote external state"
	);
	assert(plan.state === "failed", "Failed plan state was not retained");
	assert(plan.export().effects.length === 2, "Failed plan lost its effects");
}

function testInterruptedWorkPlan(tw, operation, timing) {
	var wiki = new tw.Wiki();

	wiki.addTiddler(new tw.Tiddler({
		title: "Recovery First",
		text: "Original first"
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: "Recovery Second",
		text: "Original second"
	}));

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	plan.patch("Recovery First", {
		text: "Committed first"
	});

	if (operation === "put") {
		plan.patch("Recovery Second", {
			text: "Committed second"
		});
	} else {
		plan.remove("Recovery Second");
	}

	plan.put({
		title: "Recovery Third",
		text: "Created third"
	});

	var expectedPlan = JSON.stringify(plan.export());
	var originalAdd = wiki.addTiddler.bind(wiki);
	var originalDelete = wiki.deleteTiddler.bind(wiki);
	var injected = false;

	function interruptBefore() {
		if (timing === "before") {
			injected = true;
			throw new Error("Injected materialization interruption");
		}
	}

	function interruptAfter() {
		if (timing === "after") {
			injected = true;
			throw new Error("Injected materialization interruption");
		}
	}

	wiki.addTiddler = function (tiddler) {
		if (
			operation === "put" &&
			tiddler.fields.title === "Recovery Second" &&
			!injected
		) {
			interruptBefore();
			var result = originalAdd(tiddler);
			interruptAfter();
			return result;
		}

		return originalAdd(tiddler);
	};

	wiki.deleteTiddler = function (title) {
		if (
			operation === "delete" &&
			title === "Recovery Second" &&
			!injected
		) {
			interruptBefore();
			var result = originalDelete(title);
			interruptAfter();
			return result;
		}

		return originalDelete(title);
	};

	try {
		assertThrows(function () {
			plan.commit();
		}, "Injected");

		assert(injected, "Failure injection did not run");
		assert(plan.state === "failed", "Interrupted plan was not retained");

		assert(
			wiki.getTiddler("Recovery First").fields.text === "Committed first",
			"First effect was not materialized before interruption"
		);
		assert(
			!wiki.tiddlerExists("Recovery Third"),
			"Materialization continued after interruption"
		);

		if (operation === "put") {
			assert(
				wiki.getTiddler("Recovery Second").fields.text ===
					(
						timing === "before"
							? "Original second"
							: "Committed second"
					),
				"Wrong state at the interrupted put"
			);
		} else {
			assert(
				wiki.tiddlerExists("Recovery Second") === (timing === "before"),
				"Wrong state at the interrupted deletion"
			);
		}

		assert(
			JSON.stringify(plan.export()) === expectedPlan,
			"Interrupted plan lost or changed its effects"
		);

		assertThrows(function () {
			plan.abort();
		}, "not open");

		// Simulate a fresh process: reconstruct materialized state and
		// restore only the JSON representation of the work plan.
		var recoveredWiki = new tw.Wiki();

		wiki.each(function (tiddler) {
			recoveredWiki.addTiddler(
				new tw.Tiddler(effects.capture(tiddler))
			);
		});

		var recoveredPlan = JSON.parse(expectedPlan);
		var results = workPlans.materialize(
			recoveredWiki,
			tw.Tiddler,
			recoveredPlan
		);

		assert(results.length === 3, "Recovery lost an effect");
		assert(results[0] === "already-applied", "First effect was not recognized");
		assert(
			results[1] ===
				(timing === "before" ? "applied" : "already-applied"),
			"Interrupted effect was incorrectly classified"
		);
		assert(results[2] === "applied", "Remaining creation was not performed");

		assert(
			recoveredWiki.getTiddler("Recovery First").fields.text ===
				"Committed first",
			"Recovery changed the first result"
		);

		if (operation === "put") {
			assert(
				recoveredWiki.getTiddler("Recovery Second").fields.text ===
					"Committed second",
				"Recovery did not finish the update"
			);
		} else {
			assert(
				!recoveredWiki.tiddlerExists("Recovery Second"),
				"Recovery did not finish the deletion"
			);
		}

		assert(
			recoveredWiki.getTiddler("Recovery Third").fields.text ===
				"Created third",
			"Recovery did not finish the creation"
		);

		var replay = workPlans.materialize(
			recoveredWiki,
			tw.Tiddler,
			JSON.parse(expectedPlan)
		);

		assert(
			replay.every(function (result) {
				return result === "already-applied";
			}),
			"Completed plan was not replay-safe"
		);
	} finally {
		wiki.addTiddler = originalAdd;
		wiki.deleteTiddler = originalDelete;
	}
}

function testPersistentRegistryReaction(tw, fail) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/planned-registry-test";
	var realStateUnchangedDuringReaction = false;
	var readOwnWrites = false;
	var savedMemo = null;

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "planned-registry-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			note: {
				form: "memo",
				data: { value: 0 }
			}
		})
	}));

	var initial = effects.capture(wiki.getTiddler(title));

	function react(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var memo = operational.get("note");
		var charter = operational.get("charter");

		memo.setData({ value: 1 });
		charter.setStatus({ phase: "planned" });
		memo.setData({ value: 2 });

		savedMemo = memo;

		readOwnWrites =
			memo.data().value === 2 &&
			charter.status().phase === "planned";

		realStateUnchangedDuringReaction =
			JSON.stringify(effects.capture(wiki.getTiddler(title))) ===
			JSON.stringify(initial);

		if (fail) {
			throw new Error("Deliberate planned reaction failure");
		}
	}

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "planned-registry-test",
				browser: react,
				node: react
			}
		])
	});

	runtime.start();

	try {
		dispatcher.start();

		assert(readOwnWrites, "Planned reaction did not read its own writes");
		assert(
			realStateUnchangedDuringReaction,
			"Planned reaction changed the real wiki before completion"
		);

		assertThrows(function () {
			savedMemo.data();
		}, "closed");

		var current = effects.capture(wiki.getTiddler(title));
		var errors = dispatcher.inspect().errors;

		if (fail) {
			var registry = JSON.parse(current.text);

			assert(
				registry.note.data.value === 0,
				"Failed reaction materialized its memo changes"
			);
			assert(
				registry.charter.status.phase === "suspended" &&
				registry.charter.status.previous.phase === "initial",
				"Wrong suspension status"
			);
			assert(errors.length === 1, "Missing planned reaction error");
			assert(
				errors[0].phase === "reaction" &&
				errors[0].message === "Deliberate planned reaction failure",
				"Wrong planned reaction diagnostic"
			);
			assert(!errors[0].workPlan, "Aborted reaction retained a commit plan");
			assert(errors[0].walTitle, "Incident WAL missing");
		} else {
			var registry = JSON.parse(current.text);

			assert(registry.note.data.value === 2, "Planned memo was not committed");
			assert(
				registry.charter.status.phase === "planned",
				"Planned status was not committed"
			);
			assert(errors.length === 0, "Successful reaction produced errors");
		}

		assert(
			current["clerus-custody"] === (fail ? "user" : platform),
			"Wrong custody after the reaction"
		);
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testRegistryWalRecovery(tw, alreadyApplied) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/wal-owner";

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			}
		})
	}));

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	plan.patch(title, {
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "committed" }
			}
		})
	});

	var compiled = plan.export();
	var wal = new Wal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () {
			return "recovery-test";
		}
	});

	var journalTitle = wal.record({
		title: title,
		executor: "test",
		persistent: true
	}, compiled);

	if (alreadyApplied) {
		// Simulate stopping after owner update but before WAL deletion.
		workPlans.materialize(wiki, tw.Tiddler, compiled);
	}

	var restarted = new tw.Wiki();

	wiki.each(function (tiddler) {
		restarted.addTiddler(new tw.Tiddler(effects.capture(tiddler)));
	});

	var recovered = new Wal({
		wiki: restarted,
		Tiddler: tw.Tiddler,
		platform: platform
	}).recover();

	assert(recovered.length === 1, "WAL was not discovered");
	assert(recovered[0].status === "recovered", "WAL recovery failed");
	assert(
		recovered[0].results[0] ===
			(alreadyApplied ? "already-applied" : "applied"),
		"Owner effect was incorrectly classified"
	);

	assert(!restarted.tiddlerExists(journalTitle), "Completed WAL remained");

	var registry = JSON.parse(restarted.getTiddler(title).fields.text);

	assert(
		registry.charter.status.phase === "committed",
		"Recovered registry has the wrong state"
	);

	plan.abort();
}

function testRegistryWalCustody(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/wal-custody-owner";

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "test",
		text: JSON.stringify({
			charter: { form: "charter", status: "initial" }
		})
	}));

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	plan.patch(title, {
		text: JSON.stringify({
			charter: { form: "charter", status: "planned" }
		})
	});

	var wal = new Wal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () {
			return "custody-test";
		}
	});

	var journalTitle = wal.record({
		title: title,
		executor: "test",
		persistent: true
	}, plan.export());

	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(title),
		{ "clerus-custody": "user" }
	));

	assertThrows(function () {
		wal.resume(journalTitle);
	}, "no longer locally authorized");

	var journal = wiki.getTiddler(journalTitle);

	assert(journal.fields["clerus-custody"] === "user", "Failed WAL was not paused");
	assert(journal.fields["clerus-wal-error"], "WAL diagnostic missing");

	assert(
		JSON.parse(wiki.getTiddler(title).fields.text).charter.status === "initial",
		"Recovery overwrote a user-owned job"
	);

	assert(wal.recover()[0].status === "paused", "Paused WAL was retried automatically");

	plan.abort();
}

async function testPersistentSuspension(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/suspension-test";
	var mission = linkedMissionFactory("Suspension Project", []);
	var suspended = false;
	var writeRefused = false;
	var resumedCount = 0;
	var readyCount = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "suspension-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			note: { form: "memo", data: { value: 0 } },
			mission: mission([])
		})
	}));

	function react(event, operational) {
		if (event.type === "ready") {
			readyCount++;
			operational.get("note").setData({ value: 1 });
			throw new Error("Deliberate persistent failure");
		}

		if (event.type === "suspended") {
			suspended = operational.keys().indexOf("mission") !== -1;

			try {
				operational.get("note").setData({ value: 99 });
			} catch (error) {
				writeRefused =
					String(error.message).indexOf("read-only") !== -1;
			}

			return;
		}

		if (event.type === "resumed") {
			resumedCount++;
			operational.get("note").setData({ value: 2 });
			operational.get("charter").setStatus({ phase: "running" });
		}
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "suspension-test",
				browser: react,
				node: react
			}
		])
	});

	runtime.start();

	try {
		dispatcher.start();

		var current = wiki.getTiddler(title);
		var registry = JSON.parse(current.fields.text);

		assert(suspended, "Suspended event lost the mission");
		assert(writeRefused, "Suspended executor could still write");
		assert(current.fields["clerus-custody"] === "user", "Job was not suspended");
		assert(current.fields["clerus-suspended"] === "yes", "Suspension marker missing");
		assert(registry.note.data.value === 0, "Failed reaction was committed");
		assert(registry.mission, "Suspension removed the assignment");
		assert(registry.charter.status.phase === "suspended", "Wrong failure status");

		var diagnostic = dispatcher.inspect().errors[0];
		var incident = wiki.getTiddler(diagnostic.walTitle);

		assert(incident, "Incident WAL missing");
		assert(incident.fields["clerus-custody"] === "user", "Incident is not user-owned");
		assert(
			JSON.parse(incident.fields.text).incident.event.type === "ready",
			"Incident context missing"
		);

		wiki.addTiddler(new tw.Tiddler(current, {
			"clerus-custody": platform
		}));

		await waitFor(function () {
			return resumedCount === 1 &&
				!wiki.getTiddler(title).fields["clerus-suspended"];
		}, 2000);

		registry = JSON.parse(wiki.getTiddler(title).fields.text);

		assert(registry.note.data.value === 2, "Resumed changes were not committed");
		assert(registry.charter.status.phase === "running", "Resumption failed");
		assert(registry.mission, "Resumption removed the assignment");
		assert(dispatcher.inspect().errors.length === 0, "Old runtime error remained");
		assert(wiki.tiddlerExists(diagnostic.walTitle), "Incident was silently deleted");

		dispatcher.scan();

		assert(readyCount === 1 && resumedCount === 1, "Unexpected reactivation");
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testRecoveryBeforeActivation(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/boot-recovery-test";
	var observedPhase = null;

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "boot-recovery-test",
		text: JSON.stringify({
			charter: { form: "charter", status: { phase: "initial" } }
		})
	}));

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	plan.patch(title, {
		text: JSON.stringify({
			charter: { form: "charter", status: { phase: "recovered" } }
		})
	});

	var journalTitle = new Wal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () { return "boot-order-test"; }
	}).record({
		title: title,
		executor: "boot-recovery-test",
		persistent: true
	}, plan.export());

	function react(event, operational) {
		if (event.type === "ready") {
			observedPhase = operational.get("charter").status().phase;
		}
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "boot-recovery-test",
				browser: react,
				node: react
			}
		])
	});

	runtime.start();

	try {
		dispatcher.start();

		assert(observedPhase === "recovered", "Executor ran before recovery");
		assert(!wiki.tiddlerExists(journalTitle), "Recovered WAL remained");
		assert(
			dispatcher.inspect().recovery[0].status === "recovered",
			"Recovery diagnostic missing"
		);
		assert(dispatcher.inspect().errors.length === 0, "Unexpected boot errors");
	} finally {
		dispatcher.stop();
		runtime.stop();
		plan.abort();
	}
}

function testPersistentExternalWrite(tw, fail) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var ownerTitle = "$:/clerus/jobs/external-write-test";
	var targetTitle = "Persistent Write Target";
	var virtualReadsWorked = false;
	var realTargetStayedUnchanged = false;

	wiki.addTiddler(new tw.Tiddler({
		title: targetTitle,
		"clerus-custody": platform,
		tags: ["external-write"],
		caption: "Remove me",
		text: "Initial"
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: ownerTitle,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "external-write-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			note: { form: "memo", data: { value: 0 } },
			document: targetTitle,
			permission: {
				form: "warrant",
				filter: "[tag[external-write]]",
				operations: ["patch"],
				fields: ["text", "caption"]
			}
		})
	}));

	function react(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var document = operational.get("document");

		document.patch("permission", {
			set: { text: "First" }
		});

		document.patch("permission", {
			set: { text: "Final" },
			remove: ["caption"]
		});

		virtualReadsWorked =
			document.text() === "Final" &&
			document.field("caption") === undefined;

		realTargetStayedUnchanged =
			wiki.getTiddler(targetTitle).fields.text === "Initial" &&
			wiki.getTiddler(targetTitle).fields.caption === "Remove me";

		operational.get("note").setData({ value: 1 });

		if (fail) {
			throw new Error("Deliberate external-write failure");
		}

		operational.get("charter").setStatus({ phase: "committed" });
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "external-write-test",
				browser: react,
				node: react
			}
		])
	});

	runtime.start();

	try {
		dispatcher.start();

		assert(virtualReadsWorked, "External read-your-writes failed");
		assert(realTargetStayedUnchanged, "External writes escaped planning");

		var target = wiki.getTiddler(targetTitle);
		var registry = JSON.parse(wiki.getTiddler(ownerTitle).fields.text);

		if (fail) {
			assert(target.fields.text === "Initial", "Failed reaction changed target");
			assert(target.fields.caption === "Remove me", "Failed reaction removed field");
			assert(registry.note.data.value === 0, "Failed reaction changed memo");
			assert(
				registry.charter.status.phase === "suspended",
				"Failed persistent owner was not suspended"
			);
		} else {
			assert(target.fields.text === "Final", "External write was not committed");
			assert(target.fields.caption === undefined, "Field removal was not committed");
			assert(registry.note.data.value === 1, "Memo was not committed");
			assert(registry.charter.status.phase === "committed", "Status was not committed");
			assert(dispatcher.inspect().errors.length === 0, "Unexpected commit errors");

			var journals = [];

			wiki.each(function (tiddler, title) {
				if (title.indexOf(dispatcher.wal.prefix) === 0) {
					journals.push(title);
				}
			});

			assert(journals.length === 0, "Completed WAL remained");
		}
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testExternalWalRecovery(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/external-recovery-owner";
	var target = "External Recovery Target";

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "test",
		text: JSON.stringify({
			charter: { form: "charter", status: "initial" }
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		text: "Initial"
	}));

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	// External target goes first; owner remains unmodified at interruption.
	plan.patch(target, { text: "Recovered" });
	plan.patch(owner, {
		text: JSON.stringify({
			charter: { form: "charter", status: "recovered" }
		})
	});

	var compiled = plan.export();
	var wal = new Wal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () { return "external-recovery"; }
	});

	var journalTitle = wal.record({
		title: owner,
		executor: "test",
		persistent: true
	}, compiled, {
		ownerState: plan.initial(owner)
	});

	effects.apply(wiki, tw.Tiddler, compiled.effects[0]);

	var restarted = new tw.Wiki();

	wiki.each(function (tiddler) {
		restarted.addTiddler(new tw.Tiddler(effects.capture(tiddler)));
	});

	var recovery = new Wal({
		wiki: restarted,
		Tiddler: tw.Tiddler,
		platform: platform
	}).recover();

	assert(recovery[0].status === "recovered", "Multi-target recovery failed");
	assert(
		recovery[0].results.join(",") === "already-applied,applied",
		"Wrong recovery progress"
	);
	assert(!restarted.tiddlerExists(journalTitle), "Recovered journal remained");
	assert(
		JSON.parse(restarted.getTiddler(owner).fields.text).charter.status === "recovered",
		"Owner update was not recovered"
	);
	assert(restarted.getTiddler(target).fields.text === "Recovered", "Target result was lost");

	plan.abort();
}

function testPersistentExternalDeletion(tw, fail) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/external-deletion-test";
	var target = "Planned Deletion Target";
	var virtualDeletionVisible = false;
	var realTargetPreservedDuringReaction = false;
	var writeAfterDeletionRefused = false;
	var savedDocument = null;

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		tags: ["planned-delete"],
		text: "Preserve until commit"
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "external-deletion-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			document: target,
			permission: {
				form: "warrant",
				filter: "[tag[planned-delete]]",
				operations: ["patch", "delete"],
				fields: ["text"]
			}
		})
	}));

	var ownerBefore = effects.capture(wiki.getTiddler(owner));

	function react(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var document = operational.get("document");

		savedDocument = document;
		document.delete("permission");

		virtualDeletionVisible = !document.inspect().exists;
		realTargetPreservedDuringReaction = wiki.tiddlerExists(target);

		try {
			document.patch("permission", {
				set: { text: "Too late" }
			});
		} catch (error) {
			writeAfterDeletionRefused =
				String(error.message).indexOf("absent") !== -1;
		}

		if (fail) {
			throw new Error("Deliberate planned deletion failure");
		}

		// Deliberately do not modify the owner's registry.
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "external-deletion-test",
				browser: react,
				node: react
			}
		])
	});

	runtime.start();

	try {
		dispatcher.start();

		assert(virtualDeletionVisible, "Virtual deletion was not visible");
		assert(
			realTargetPreservedDuringReaction,
			"Deletion escaped the planning phase"
		);
		assert(
			writeAfterDeletionRefused,
			"Deleted virtual target remained writable"
		);

		assertThrows(function () {
			savedDocument.inspect();
		}, "closed");

		var registry = JSON.parse(wiki.getTiddler(owner).fields.text);

		assert(
			registry.document === target,
			"Deletion removed the title document"
		);

		if (fail) {
			assert(wiki.tiddlerExists(target), "Failed reaction deleted the target");
			assert(
				wiki.getTiddler(target).fields.text === "Preserve until commit",
				"Failed deletion changed the target"
			);
			assert(
				registry.charter.status.phase === "suspended",
				"Failed owner was not suspended"
			);
		} else {
			assert(!wiki.tiddlerExists(target), "Deletion was not committed");
			assert(
				JSON.stringify(effects.capture(wiki.getTiddler(owner))) ===
					JSON.stringify(ownerBefore),
				"External-only commit changed the owner"
			);
			assert(
				dispatcher.inspect().errors.length === 0,
				"Successful deletion produced errors"
			);
		}
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testExternalWalOwnerGuard(tw, stage) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/external-owner-guard";
	var target = "Owner Guard Target";

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "test",
		text: JSON.stringify({
			charter: { form: "charter", status: "initial" },
			document: target,
			permission: {
				form: "warrant",
				filter: "[title[Owner Guard Target]]",
				operations: ["patch"],
				fields: ["text"]
			}
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		text: "Initial"
	}));

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	plan.patch(target, { text: "Planned" });

	var compiled = plan.export();
	var descriptor = {
		title: owner,
		executor: "test",
		persistent: true
	};
	var registrationOptions = {
		ownerState: plan.initial(owner)
	};

	var wal = new Wal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () { return "owner-guard-test"; }
	});

	var journalTitle = stage === "recovery"
		? wal.record(descriptor, compiled, registrationOptions)
		: null;

	// Change the permission without changing executor or custody.
	var current = wiki.getTiddler(owner);
	var registry = JSON.parse(current.fields.text);

	registry.permission.fields = [];

	wiki.addTiddler(new tw.Tiddler(current, {
		text: JSON.stringify(registry)
	}));

	var changedOwner = effects.capture(wiki.getTiddler(owner));

	try {
		assert(
			compiled.effects.length === 1 &&
			compiled.effects[0].title === target,
			"Test accidentally included an owner effect"
		);

		if (stage === "registration") {
			assertThrows(function () {
				wal.record(descriptor, compiled, registrationOptions);
			}, "owner state has changed");

			var journals = [];

			wiki.each(function (tiddler, title) {
				if (title.indexOf(wal.prefix) === 0) {
					journals.push(title);
				}
			});

			assert(journals.length === 0, "Rejected registration left a WAL");
		} else {
			var restarted = new tw.Wiki();

			wiki.each(function (tiddler) {
				restarted.addTiddler(
					new tw.Tiddler(effects.capture(tiddler))
				);
			});

			var recoveredWal = new Wal({
				wiki: restarted,
				Tiddler: tw.Tiddler,
				platform: platform
			});

			var recovery = recoveredWal.recover();

			assert(recovery[0].status === "failed", "Changed owner was accepted");
			assert(
				recovery[0].error.message.indexOf("owner state has changed") !== -1,
				"Wrong owner-guard diagnostic"
			);
			assert(
				restarted.getTiddler(journalTitle).fields["clerus-custody"] === "user",
				"Blocked WAL was not paused"
			);
			assert(
				restarted.getTiddler(target).fields.text === "Initial",
				"Recovery used the obsolete permission"
			);
			assert(
				JSON.stringify(effects.capture(restarted.getTiddler(owner))) ===
					JSON.stringify(changedOwner),
				"Recovery overwrote the changed owner"
			);
		}

		assert(
			wiki.getTiddler(target).fields.text === "Initial",
			"Owner-guard test materialized an external write"
		);
	} finally {
		plan.abort();
	}
}

function testExternalDeletionWalRecovery(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/deletion-recovery-owner";
	var target = "Deletion Recovery Target";

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "test",
		text: JSON.stringify({
			charter: { form: "charter", status: "unchanged" }
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		text: "Delete me"
	}));

	var ownerBefore = effects.capture(wiki.getTiddler(owner));
	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	plan.remove(target);

	var compiled = plan.export();
	var wal = new Wal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () { return "deletion-recovery"; }
	});

	var journalTitle = wal.record({
		title: owner,
		executor: "test",
		persistent: true
	}, compiled, {
		ownerState: plan.initial(owner)
	});

	// Stop after deletion but before removing the journal.
	effects.apply(wiki, tw.Tiddler, compiled.effects[0]);

	var restarted = new tw.Wiki();

	wiki.each(function (tiddler) {
		restarted.addTiddler(new tw.Tiddler(effects.capture(tiddler)));
	});

	try {
		var recovery = new Wal({
			wiki: restarted,
			Tiddler: tw.Tiddler,
			platform: platform
		}).recover();

		assert(recovery[0].status === "recovered", "Deletion recovery failed");
		assert(
			recovery[0].results[0] === "already-applied",
			"Completed deletion was not recognized"
		);
		assert(!restarted.tiddlerExists(target), "Deleted target reappeared");
		assert(!restarted.tiddlerExists(journalTitle), "Completed journal remained");
		assert(
			JSON.stringify(effects.capture(restarted.getTiddler(owner))) ===
				JSON.stringify(ownerBefore),
			"External deletion recovery changed the owner"
		);
	} finally {
		plan.abort();
	}
}

function testPersistentTemplateCreation(tw, fail) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/persistent-creation-test";
	var target = "Generated Reports/First";
	var readOwnCreation = false;
	var realCreationDeferred = false;

	var warrant = {
		form: "warrant",
		filter: "[tag[generated-report]]",
		operations: ["create"],
		fields: [],
		templates: {
			report: {
				title: "Generated Reports/{{name}}",
				parameters: {
					name: "segment",
					body: "string"
				},
				fields: {
					type: "text/plain",
					tags: "generated-report",
					text: "{{body}}"
				}
			}
		}
	};

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "persistent-creation-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			note: { form: "memo", data: { value: 0 } },
			permission: warrant
		})
	}));

	function react(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var created = operational.get("permission").create(
			"report",
			{ name: "First", body: "Planned content" },
			"created"
		);

		readOwnCreation =
			created.inspect().exists &&
			created.text() === "Planned content" &&
			operational.get("created").field("title") === target;

		realCreationDeferred =
			!wiki.tiddlerExists(target) &&
			!JSON.parse(wiki.getTiddler(owner).fields.text).created;

		operational.get("note").setData({ value: 1 });

		if (fail) {
			throw new Error("Deliberate template creation failure");
		}

		operational.get("charter").setStatus({ phase: "created" });
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "persistent-creation-test",
				browser: react,
				node: react
			}
		])
	});

	runtime.start();

	try {
		dispatcher.start();

		assert(readOwnCreation, "Created document was not visible in the plan");
		assert(realCreationDeferred, "Creation escaped the planning phase");

		var registry = JSON.parse(wiki.getTiddler(owner).fields.text);

		if (fail) {
			assert(!wiki.tiddlerExists(target), "Failed reaction created the target");
			assert(!registry.created, "Failed reaction filed the title");
			assert(registry.note.data.value === 0, "Failed reaction changed the memo");
			assert(
				registry.charter.status.phase === "suspended",
				"Failed creator was not suspended"
			);
		} else {
			var created = wiki.getTiddler(target);

			assert(created, "Target was not materialized");
			assert(created.fields.text === "Planned content", "Wrong created content");
			assert(created.fields["clerus-custody"] === platform, "Wrong created custody");
			assert(registry.created === target, "Created title was not filed");
			assert(registry.note.data.value === 1, "Memo was not committed");
			assert(registry.charter.status.phase === "created", "Status was not committed");
			assert(dispatcher.inspect().errors.length === 0, "Unexpected creation errors");

			var journals = [];

			wiki.each(function (tiddler, title) {
				if (title.indexOf(dispatcher.wal.prefix) === 0) {
					journals.push(title);
				}
			});

			assert(journals.length === 0, "Completed creation WAL remained");
		}
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testTemplateCreationWalRecovery(tw, objectAlreadyCreated) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/template-recovery-owner";
	var target = "Recovered Generated Document";

	var registry = {
		charter: { form: "charter", status: "initial" }
	};

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "test",
		text: JSON.stringify(registry)
	}));

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	plan.put({
		title: target,
		type: "text/plain",
		"clerus-custody": platform,
		text: "Recovered content"
	});

	registry.created = target;
	registry.charter.status = "created";

	plan.patch(owner, {
		text: JSON.stringify(registry)
	});

	var compiled = plan.export();
	var wal = new Wal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () { return "template-recovery"; }
	});

	var journalTitle = wal.record({
		title: owner,
		executor: "test",
		persistent: true
	}, compiled, {
		ownerState: plan.initial(owner)
	});

	if (objectAlreadyCreated) {
		// Stop after creating the object but before filing its title.
		effects.apply(wiki, tw.Tiddler, compiled.effects[0]);
	}

	var restarted = new tw.Wiki();

	wiki.each(function (tiddler) {
		restarted.addTiddler(new tw.Tiddler(effects.capture(tiddler)));
	});

	try {
		var recovery = new Wal({
			wiki: restarted,
			Tiddler: tw.Tiddler,
			platform: platform
		}).recover();

		assert(recovery[0].status === "recovered", "Creation recovery failed");
		assert(
			recovery[0].results[0] ===
				(objectAlreadyCreated ? "already-applied" : "applied"),
			"Creation progress was incorrectly classified"
		);
		assert(recovery[0].results[1] === "applied", "Title filing was not recovered");

		assert(
			restarted.getTiddler(target).fields.text === "Recovered content",
			"Created object was not recovered"
		);
		assert(
			JSON.parse(restarted.getTiddler(owner).fields.text).created === target,
			"Recovered owner lacks the created title"
		);
		assert(!restarted.tiddlerExists(journalTitle), "Completed journal remained");
	} finally {
		plan.abort();
	}
}

function testPlannedTemplateFollowup(tw, mode) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/template-followup-test";
	var target = "Template Followup/" + mode;
	var followupWorked = false;
	var otherWarrantRefused = false;
	var realTargetAbsentDuringReaction = false;

	var permission = {
		form: "warrant",
		filter: "[tag[generated-report]]",
		operations: ["create", "patch", "delete"],
		fields: ["text", "caption"],
		templates: {
			report: {
				title: "Template Followup/{{name}}",
				parameters: {
					name: "segment"
				},
				fields: {
					text: "Template content",
					caption: "Template caption",
					tags: "generated-report"
				},
				followup: mode === "denied"
					? []
					: [mode === "delete" ? "delete" : "patch"]
			}
		}
	};

	var otherPermission = JSON.parse(JSON.stringify(permission));

	otherPermission.filter = "[all[tiddlers]]";

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "template-followup-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			permission: permission,
			otherPermission: otherPermission
		})
	}));

	function react(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var document = operational.get("permission").create(
			"report",
			{ name: mode },
			"created"
		);

		try {
			document.patch("otherPermission", {
				set: { text: "Wrong authority" }
			});
		} catch (error) {
			otherWarrantRefused =
				String(error.message).indexOf("another warrant") !== -1;
		}

		if (mode === "delete") {
			document.delete("permission");
			followupWorked = !document.inspect().exists;
		} else if (mode === "denied") {
			try {
				document.patch("permission", {
					set: { text: "Forbidden" }
				});
			} catch (error) {
				followupWorked =
					String(error.message).indexOf(
						"Template does not allow followup"
					) !== -1;
			}

			followupWorked = followupWorked &&
				document.text() === "Template content";
		} else {
			document.patch("permission", {
				set: { text: "Completed content" },
				remove: ["caption"]
			});

			followupWorked =
				document.text() === "Completed content" &&
				document.field("caption") === undefined;
		}

		realTargetAbsentDuringReaction = !wiki.tiddlerExists(target);

		operational.get("charter").setStatus({
			phase: "finished"
		});
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "template-followup-test",
				browser: react,
				node: react
			}
		])
	});

	runtime.start();

	try {
		dispatcher.start();

		assert(followupWorked, "Template followup policy was not enforced");
		assert(otherWarrantRefused, "Another warrant inherited creation authority");
		assert(
			realTargetAbsentDuringReaction,
			"Template followup escaped the planning phase"
		);

		var registry = JSON.parse(wiki.getTiddler(owner).fields.text);

		assert(registry.created === target, "Created title was not filed");
		assert(
			registry.charter.status.phase === "finished",
			"Owner changes did not commit"
		);

		if (mode === "delete") {
			assert(!wiki.tiddlerExists(target), "Create/delete pair was materialized");
		} else {
			var tiddler = wiki.getTiddler(target);

			assert(tiddler, "Planned creation was not committed");
			assert(
				tiddler.fields.text ===
					(mode === "denied" ? "Template content" : "Completed content"),
				"Wrong final content"
			);

			if (mode === "patch") {
				assert(tiddler.fields.caption === undefined, "Field removal was lost");
			}
		}

		assert(
			dispatcher.inspect().errors.length === 0,
			"Template followup produced unexpected errors"
		);
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testPersistentProjectParts(tw, mode) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/planned-project-parts";
	var project = "Planned Parts Project";
	var mission = linkedMissionFactory(project, [["section"]]);
	var realProjectUnchanged = false;
	var duplicateRefused = false;
	var custodyRefused = false;
	var ownRoleReadable = false;

	var initialTree = {
		task: { name: "root" },
		parts: {
			section: {
				task: { name: "section" },
				parts: {}
			},
			sibling: {
				task: { name: "preserved sibling" },
				parts: {}
			}
		}
	};

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": mode === "foreign" ? "user" : platform,
		caption: "Preserved project caption",
		text: JSON.stringify(initialTree)
	}));

	var projectBefore = effects.capture(wiki.getTiddler(project));

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "planned-project-parts",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			root: mission([]),
			mission: mission(["section"])
		})
	}));

	function react(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var mission = operational.get("mission");

		ownRoleReadable = mission.task().name === "section";

		if (mode === "foreign") {
			try {
				mission.createPart("alpha", { name: "forbidden" });
			} catch (error) {
				custodyRefused =
					String(error.message).indexOf("not owned") !== -1;
			}

			operational.get("charter").setStatus({ phase: "blocked" });
			return;
		}

		var task = { name: "alpha" };

		mission.createPart("alpha", task);
		task.name = "caller mutation";

		mission.createPart("beta", { name: "beta" });

		try {
			mission.createPart("alpha", { name: "overwrite" });
		} catch (error) {
			duplicateRefused =
				String(error.message).indexOf("already exists") !== -1;
		}

		realProjectUnchanged =
			JSON.stringify(effects.capture(wiki.getTiddler(project))) ===
			JSON.stringify(projectBefore);

		if (mode === "fail") {
			throw new Error("Deliberate planned project failure");
		}

		operational.get("charter").setStatus({ phase: "populated" });
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "planned-project-parts",
				browser: react,
				node: react
			}
		])
	});

	runtime.start();

	try {
		dispatcher.start();

		assert(ownRoleReadable, "Assigned task was not readable");

		var currentProject = wiki.getTiddler(project);
		var tree = JSON.parse(currentProject.fields.text);
		var registry = JSON.parse(wiki.getTiddler(owner).fields.text);

		if (mode === "foreign") {
			assert(custodyRefused, "Project custody restriction was ignored");
			assert(
				JSON.stringify(effects.capture(currentProject)) ===
					JSON.stringify(projectBefore),
				"Foreign project was modified"
			);
			assert(
				registry.charter.status.phase === "blocked",
				"Caught authorization error prevented the owner commit"
			);
			assert(dispatcher.inspect().errors.length === 0, "Caught refusal was penalized");
		} else {
			assert(realProjectUnchanged, "Project changes escaped planning");
			assert(duplicateRefused, "Second operation did not see the first child");

			if (mode === "fail") {
				assert(
					JSON.stringify(effects.capture(currentProject)) ===
						JSON.stringify(projectBefore),
					"Failed reaction modified the project"
				);
				assert(
					registry.charter.status.phase === "suspended",
					"Failed project executor was not suspended"
				);
			} else {
				var parts = tree.parts.section.parts;

				assert(parts.alpha.task.name === "alpha", "Task argument was not copied");
				assert(parts.beta.task.name === "beta", "Second child was lost");
				assert(
					Object.keys(parts).length === 2,
					"Unexpected child structure"
				);
				assert(
					registry.charter.status.phase === "populated",
					"Owner status did not commit"
				);
				assert(dispatcher.inspect().errors.length === 0, "Unexpected project errors");
			}
		}

		assert(tree.task.name === "root", "Root configuration was changed");
		assert(
			tree.parts.sibling.task.name === "preserved sibling",
			"Sibling task was changed"
		);
		assert(
			currentProject.fields.caption === "Preserved project caption",
			"Unrelated project field was lost"
		);
		assert(registry.root && registry.mission, "Assignments were removed");
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testPlannedMissionCreation(tw, mode) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/planned-mission-test";
	var project = "Planned Mission Project";
	var worker = "$:/temp/clerus/jobs/" + platform + "/occupied-worker";
	var occupied = mode === "occupied" || mode === "occupied-fail";
	var fail = mode === "fail" || mode === "occupied-fail";
	var mission = linkedMissionFactory(
		project,
		occupied ? [["worker"]] : []
	);

	var newRolesReadable = false;
	var duplicateKeyRefused = false;
	var realStateUnchanged = false;

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: { name: "root" },
			parts: occupied
				? {
					worker: {
						task: { name: "worker" },
						parts: {}
					}
				}
				: {}
		})
	}));

	var registry = {
		charter: {
			form: "charter",
			status: { phase: "initial" }
		},
		mission: mission([])
	};

	var oldMission = occupied ? mission(["worker"]) : null;

	if (occupied) {
		registry.worker = worker;

		wiki.addTiddler(new tw.Tiddler({
			title: worker,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "unused",
			text: JSON.stringify({
				charter: { form: "charter", status: {} },
				mission: oldMission
			})
		}));
	}

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "planned-mission-test",
		text: JSON.stringify(registry)
	}));

	var projectBefore = effects.capture(wiki.getTiddler(project));
	var ownerBefore = effects.capture(wiki.getTiddler(owner));
	var workerBefore = occupied
		? effects.capture(wiki.getTiddler(worker))
		: null;

	function react(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var root = operational.get("mission");

		if (!occupied) {
			root.createPart("worker", { name: "worker" });
		}

		var child = root.createMission("worker", "child");

		child.createPart("item", { name: "item" });

		var grandchild = child.createMission("item", "grandchild");

		newRolesReadable =
			child.task().name === "worker" &&
			grandchild.task().name === "item";

		var realRegistry = JSON.parse(
			dispatcher.runtime.wiki.getTiddler(owner).fields.text
		);

		// The real registry must still contain only the initial state.
		assert(!realRegistry.child, "Assignment escaped planning");

		if (occupied) {
			var view = dispatcher.readMission(
				worker,
				oldMission
			);

			assert(view.active, "Planning changed real assignment authority");
		}

		try {
			// Same destination key, not merely the same role.
			root.createMission("worker", "child");
		} catch (error) {
			duplicateKeyRefused =
				String(error.message).indexOf("occupied") !== -1 ||
				String(error.message).indexOf("already exists") !== -1;
		}

		realStateUnchanged =
			JSON.stringify(effects.capture(wiki.getTiddler(project))) ===
				JSON.stringify(projectBefore) &&
			JSON.stringify(effects.capture(wiki.getTiddler(owner))) ===
				JSON.stringify(ownerBefore);

		operational.get("charter").setStatus({ phase: "assigned" });

		if (fail) {
			throw new Error("Deliberate planned assignment failure");
		}
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([{
			name: "planned-mission-test",
			browser: react,
			node: react
		}])
	});

	runtime.start();

	try {
		dispatcher.start();

		assert(newRolesReadable, "New assignments were not readable");
		assert(duplicateKeyRefused, "Occupied destination key was accepted");
		assert(realStateUnchanged, "Planning changed real state");

		var current = JSON.parse(wiki.getTiddler(owner).fields.text);

		if (occupied) {
			assert(
				JSON.stringify(effects.capture(wiki.getTiddler(worker))) ===
					JSON.stringify(workerBefore),
				"Role replacement rewrote the former holder"
			);
		}

		if (fail) {
			assert(!current.child && !current.grandchild, "Aborted assignments remained");
			assert(
				JSON.stringify(effects.capture(wiki.getTiddler(project))) ===
					JSON.stringify(projectBefore),
				"Aborted reaction modified the project"
			);
			assert(
				current.charter.status.phase === "suspended",
				"Failed executor was not suspended"
			);
			assert(
				JSON.stringify(current.mission) ===
					JSON.stringify(registry.mission),
				"Aborted issuance changed the parent binding or counter"
			);

			if (occupied) {
				assert(
					missions.read(
						wiki,
						runtime.inspect().jobs,
						worker,
						oldMission
					).active,
					"Abort revoked the former holder"
				);
			}

			assert(
				dispatcher.inspect().errors.length === 1,
				"Wrong failure diagnostic count"
			);
		} else {
			assert(current.child.role.join("/") === "worker", "Wrong child role");
			assert(
				current.grandchild.role.join("/") === "worker/item",
				"Wrong grandchild role"
			);
			assert(
				current.mission.children.worker === current.child.link,
				"Parent does not select the issued assignment"
			);
			assert(
				current.charter.status.phase === "assigned",
				"Status did not commit"
			);

			if (occupied) {
				assert(
					current.child.link !== oldMission.link,
					"Replacement reused the previous label"
				);
				assert(
					!missions.read(
						wiki,
						runtime.inspect().jobs,
						worker,
						oldMission
					).active,
					"Former holder remained active"
				);
			}

			var tree = JSON.parse(wiki.getTiddler(project).fields.text);

			assert(
				tree.parts.worker.parts.item.task.name === "item",
				"Nested task was not committed"
			);
			assert(
				dispatcher.inspect().errors.length === 0,
				"Unexpected issuance errors"
			);
		}

		assert(runtime.inspect().missions.valid, "Final mission audit failed");
		assert(runtime.inspect().hierarchy.valid, "Final hierarchy audit failed");
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testOfficialMessageEffect(tw) {
	var platform = tw.browser ? "browser" : "node";
	var rules = documentFlow.loadRules(moduleSource([]));
	var source = {
		title: "$:/clerus/jobs/message-source",
		executor: "source",
		platform: platform
	};
	var recipient = {
		title: "$:/temp/clerus/jobs/" + platform + "/message-recipient",
		executor: "recipient",
		platform: platform
	};
	var registry = {
		note: {
			form: "memo",
			data: { value: 1 }
		}
	};

	var order = messageEffects.create({
		id: "order-1",
		message: "order",
		source: source,
		recipient: recipient,
		registry: registry
	}, rules);

	registry.note.data.value = 99;

	assert(order.registry.note.data.value === 1, "Message retained caller data");

	var publicOrder = messageEffects.event(order);

	assert(publicOrder.type === "order", "Wrong order event type");
	assert(publicOrder.id === "order-1", "Message identity missing");
	assert(!("source" in publicOrder), "Order disclosed its sender");
	assert(!("role" in publicOrder), "Order acquired a report signature");

	var report = messageEffects.create({
		id: "report-1",
		message: "report",
		source: source,
		recipient: recipient,
		project: "Message Project",
		role: ["worker"],
		registry: {}
	}, rules);

	var publicReport = messageEffects.event(report);

	assert(publicReport.role.join("/") === "worker", "Wrong report signature");
	assert(publicReport.project === "Message Project", "Report project missing");
	assert(!("source" in publicReport), "Report exposed unnecessary sender metadata");

	assertThrows(function () {
		messageEffects.create({
			id: "invalid",
			message: "order",
			source: source,
			recipient: recipient,
			registry: {
				mandate: { form: "contract", executor: "test" }
			}
		}, rules);
	});
}

function testMessagePlanning(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";

	wiki.addTiddler(new tw.Tiddler({
		title: "Message Plan Target",
		text: "Initial"
	}));

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	var rules = documentFlow.loadRules(moduleSource([]));

	function message(value) {
		return messageEffects.create({
			id: "stable-message",
			message: "order",
			source: {
				title: "$:/clerus/jobs/source",
				executor: "source",
				platform: platform
			},
			recipient: {
				title: "$:/temp/clerus/jobs/" + platform + "/recipient",
				executor: "recipient",
				platform: platform
			},
			registry: {
				note: { form: "memo", data: { value: value } }
			}
		}, rules);
	}

	try {
		plan.patch("Message Plan Target", { text: "Planned" });

		assert(plan.send(message(1)) === "recorded", "Message was not recorded");
		assert(
			plan.send(JSON.parse(JSON.stringify(message(1)))) === "already-recorded",
			"Repeated identity was not recognized"
		);

		assertThrows(function () {
			plan.send(message(2));
		}, "identity");

		var serialized = JSON.parse(JSON.stringify(plan.export()));

		assert(serialized.effects.length === 1, "State effect was lost");
		assert(serialized.messages.length === 1, "Message was lost or duplicated");
		assert(
			serialized.messages[0].registry.note.data.value === 1,
			"Message data changed"
		);

		assertThrows(function () {
			workPlans.materialize(wiki, tw.Tiddler, serialized);
		}, "transactional dispatcher");

		assert(
			wiki.getTiddler("Message Plan Target").fields.text === "Initial",
			"Unsupported message plan partially committed"
		);
	} finally {
		plan.abort();
	}
}

function testFlowWalRecovery(tw, stage) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = "$:/clerus/jobs/flow-source";
	var recipient = "$:/clerus/jobs/flow-recipient";

	function addJob(title, executor) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: "initial"
				}
			})
		}));
	}

	function plannedStatus(targetWiki, title, status) {
		var plan = new workPlans.WorkPlan({
			wiki: targetWiki,
			Wiki: tw.Wiki,
			Tiddler: tw.Tiddler
		});

		plan.patch(title, {
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: status
				}
			})
		});

		return plan;
	}

	addJob(source, "source");
	addJob(recipient, "recipient");

	var rootPlan = plannedStatus(wiki, source, "sent");

	rootPlan.send(messageEffects.create({
		id: "flow-order",
		message: "order",
		source: {
			title: source,
			executor: "source",
			platform: platform
		},
		recipient: {
			title: recipient,
			executor: "recipient",
			platform: platform
		},
		registry: {
			note: { form: "memo", data: { value: 42 } }
		}
	}, documentFlow.loadRules(moduleSource([]))));

	var flow = new FlowWal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () { return "flow-test"; }
	});

	var journalTitle = flow.register({
		title: source,
		executor: "source",
		persistent: true
	}, rootPlan.initial(source), rootPlan.export());

	var recipientPlan = null;

	if (stage !== "root-plan") {
		var messages = flow.resume(journalTitle);

		assert(messages.length === 1, "Root plan did not register its message");

		if (stage === "accepted-plan") {
			recipientPlan = plannedStatus(wiki, recipient, "received");

			flow.accept(
				journalTitle,
				"flow-order",
				{
					title: recipient,
					executor: "recipient",
					persistent: true
				},
				recipientPlan.initial(recipient),
				recipientPlan.export()
			);
		}
	}

	var restarted = new tw.Wiki();

	wiki.each(function (tiddler) {
		restarted.addTiddler(new tw.Tiddler(effects.capture(tiddler)));
	});

	var recoveredFlow = new FlowWal({
		wiki: restarted,
		Tiddler: tw.Tiddler,
		platform: platform
	});

	var finishingPlan = null;

	try {
		var recovery = recoveredFlow.recover();

		assert(
			JSON.parse(restarted.getTiddler(source).fields.text)
				.charter.status === "sent",
			"Source plan was not recovered"
		);

		if (stage === "accepted-plan") {
			assert(recovery[0].status === "closed", "Accepted plan did not close the flow");
		} else {
			assert(recovery[0].status === "pending", "Pending message was not recovered");
			assert(recovery[0].messages.length === 1, "Message was lost or duplicated");
			assert(
				recovery[0].messages[0].id === "flow-order",
				"Message identity changed during recovery"
			);

			// Repeated recovery must not register the message again.
			var again = recoveredFlow.recover();

			assert(again[0].messages.length === 1, "Repeated recovery duplicated delivery");

			finishingPlan = plannedStatus(restarted, recipient, "received");

			recoveredFlow.accept(
				journalTitle,
				"flow-order",
				{
					title: recipient,
					executor: "recipient",
					persistent: true
				},
				finishingPlan.initial(recipient),
				finishingPlan.export()
			);

			assert(
				recoveredFlow.pending(journalTitle).length === 0,
				"Accepted message remained dispatchable"
			);

			recoveredFlow.resume(journalTitle);
		}

		assert(
			JSON.parse(restarted.getTiddler(recipient).fields.text)
				.charter.status === "received",
			"Recipient plan was not recovered"
		);
		assert(!restarted.tiddlerExists(journalTitle), "Completed flow journal remained");
	} finally {
		rootPlan.abort();

		if (recipientPlan) {
			recipientPlan.abort();
		}

		if (finishingPlan) {
			finishingPlan.abort();
		}
	}
}

async function testPersistentFlowDispatch(tw, mode) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = "$:/clerus/jobs/dispatch-flow-source";
	var recipient = "$:/clerus/jobs/dispatch-flow-recipient";

	var orderCount = 0;
	var receivedId = null;
	var anonymous = false;
	var receiverStayedUnchanged = false;
	var savedIncoming = null;
	var suspended = false;

	function addJob(title, executor, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(Object.assign({
				charter: {
					form: "charter",
					status: { phase: "initial" }
				}
			}, registry))
		}));
	}

	addJob(source, "flow-source", {
		recipient: recipient,
		note: { form: "memo", data: { value: 42 } }
	});

	addJob(recipient, "flow-recipient", {});

	var receiverBefore = effects.capture(wiki.getTiddler(recipient));

	function sender(event, operational) {
		if (
			event.type !== "ready" ||
			operational.get("charter").status().phase !== "initial"
		) {
			return;
		}

		operational.get("recipient").order({ note: "note" });
		operational.get("charter").setStatus({ phase: "sent" });
	}

	function receiver(event, operational, incoming) {
		if (event.type === "suspended") {
			suspended = true;
			return;
		}

		if (event.type !== "order") {
			return;
		}

		orderCount++;
		receivedId = event.id;
		anonymous = !("source" in event);

		savedIncoming = incoming.get("note");
		savedIncoming.file("received");

		operational.get("charter").setStatus({ phase: "received" });

		receiverStayedUnchanged =
			JSON.stringify(effects.capture(wiki.getTiddler(recipient))) ===
			JSON.stringify(receiverBefore);

		if (mode === "failure") {
			throw new Error("Deliberate flow recipient failure");
		}
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "flow-source",
				browser: sender,
				node: sender
			},
			{
				name: "flow-recipient",
				browser: receiver,
				node: receiver
			}
		])
	});

	var prepared = null;

	if (mode === "recovery") {
		prepared = new workPlans.WorkPlan({
			wiki: wiki,
			Wiki: tw.Wiki,
			Tiddler: tw.Tiddler
		});

		var sourceRegistry = JSON.parse(wiki.getTiddler(source).fields.text);

		sourceRegistry.charter.status = { phase: "sent" };

		prepared.patch(source, {
			text: JSON.stringify(sourceRegistry)
		});

		var message = messageEffects.create({
			id: "recovered-dispatch-message",
			message: "order",
			source: {
				title: source,
				executor: "flow-source",
				platform: platform
			},
			recipient: {
				title: recipient,
				executor: "flow-recipient",
				platform: platform
			},
			registry: {
				note: { form: "memo", data: { value: 42 } }
			}
		}, documentFlow.loadRules(moduleSource([])));

		prepared.send(message);

		var journalTitle = dispatcher.flowWal.register({
			title: source,
			executor: "flow-source",
			persistent: true
		}, prepared.initial(source), prepared.export());

		// Recovery will enqueue it again; the ephemeral queue must deduplicate.
		dispatcher.queueFlowMessages(journalTitle, [message, message]);
	}

	runtime.start();

	try {
		dispatcher.start();

		await waitFor(function () {
			var current = wiki.getTiddler(recipient);
			var registry = JSON.parse(current.fields.text);

			return mode === "failure"
				? suspended && current.fields["clerus-custody"] === "user"
				: registry.charter.status.phase === "received";
		}, 2000);

		assert(orderCount === 1, "Official message was delivered more than once");
		assert(receivedId, "Official message identity was missing");
		assert(anonymous, "Order disclosed its sender");
		assert(receiverStayedUnchanged, "Recipient effects escaped planning");

		assertThrows(function () {
			savedIncoming.data();
		}, "closed");

		var senderRegistry = JSON.parse(wiki.getTiddler(source).fields.text);
		var receiverRegistry = JSON.parse(wiki.getTiddler(recipient).fields.text);
		var journals = [];

		wiki.each(function (tiddler, title) {
			if (tiddler.fields["clerus-wal-kind"] === "flow") {
				journals.push(tiddler);
			}
		});

		assert(senderRegistry.charter.status.phase === "sent", "Sender did not commit");
		assert(senderRegistry.note.data.value === 42, "Sender lost its copied memo");

		if (mode === "failure") {
			assert(!receiverRegistry.received, "Failed recipient filed the memo");
			assert(
				receiverRegistry.charter.status.phase === "suspended",
				"Failed recipient was not suspended"
			);
			assert(journals.length === 1, "Failed flow evidence was lost");
			assert(
				journals[0].fields["clerus-custody"] === "user",
				"Completed error flow was not handed to the user"
			);

			var record = JSON.parse(journals[0].fields.text);

			assert(record.pending.length === 0, "Failed message remained dispatchable");
			assert(record.errors.length === 1, "Wrong flow error count");
			assert(
				record.errors[0].message.id === receivedId,
				"Flow error lost the message identity"
			);
		} else {
			assert(receiverRegistry.received.data.value === 42, "Recipient lost the memo");
			assert(journals.length === 0, "Completed flow remained");
			assert(dispatcher.inspect().errors.length === 0, "Unexpected flow errors");
		}
	} finally {
		dispatcher.stop();
		runtime.stop();

		if (prepared) {
			prepared.abort();
		}
	}
}

async function testPersistentDeferredEvent(tw, mode) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = "$:/clerus/jobs/defer-source";
	var worker = "$:/clerus/jobs/defer-worker";
	var tickCount = 0;
	var tickId = null;
	var originalFlowFinished = false;

	function addJob(title, executor, registry, phase) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(Object.assign({
				charter: {
					form: "charter",
					status: { phase: phase }
				}
			}, registry))
		}));
	}

	addJob(source, "defer-source", {
		worker: worker
	}, mode === "recovery" ? "sent" : "initial");

	addJob(worker, "defer-worker", {
		note: { form: "memo", data: { value: 0 } }
	}, mode === "recovery" ? "waiting" : "initial");

	function sender(event, operational) {
		if (
			event.type === "ready" &&
			operational.get("charter").status().phase === "initial"
		) {
			operational.get("worker").order({});
			operational.get("charter").setStatus({ phase: "sent" });
		}
	}

	function recipient(event, operational) {
		if (event.type === "order") {
			operational.get("charter").defer();
			operational.get("charter").defer();
			operational.get("charter").setStatus({ phase: "waiting" });
			return;
		}

		if (event.type !== "tick") {
			return;
		}

		tickCount++;
		tickId = event.id;

		var flows = [];

		wiki.each(function (tiddler) {
			if (tiddler.fields["clerus-wal-kind"] === "flow") {
				flows.push(tiddler);
			}
		});

		originalFlowFinished = flows.length === 0;

		operational.get("note").setData({ value: 42 });
		operational.get("charter").setStatus({ phase: "complete" });

		if (mode === "failure") {
			throw new Error("Deliberate persistent tick failure");
		}
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "defer-source",
				browser: sender,
				node: sender
			},
			{
				name: "defer-worker",
				browser: recipient,
				node: recipient
			}
		])
	});

	if (mode === "recovery") {
		deferredWal.record(dispatcher.flowWal, deferredEffects.create({
			id: "recovered-tick",
			recipient: {
				title: worker,
				executor: "defer-worker",
				platform: platform
			}
		}));
	}

	runtime.start();

	try {
		dispatcher.start();

		await waitFor(function () {
			var current = wiki.getTiddler(worker);
			var registry = JSON.parse(current.fields.text);

			return mode === "failure"
				? current.fields["clerus-custody"] === "user"
				: registry.charter.status.phase === "complete";
		}, 2000);

		assert(tickCount === 1, "Deferred requests produced multiple ticks");
		assert(tickId, "Tick identity was missing");
		assert(originalFlowFinished, "Tick continued the original order flow");

		if (mode === "recovery") {
			assert(tickId === "recovered-tick", "Recovery changed tick identity");
		}

		var registry = JSON.parse(wiki.getTiddler(worker).fields.text);
		var journals = [];

		wiki.each(function (tiddler, title) {
			if (title.indexOf(dispatcher.wal.prefix) === 0) {
				journals.push(tiddler);
			}
		});

		if (mode === "failure") {
			assert(registry.note.data.value === 0, "Failed tick committed its memo");
			assert(registry.charter.status.phase === "suspended", "Worker not suspended");
			assert(journals.length === 1, "Failed tick evidence was lost");

			var record = JSON.parse(journals[0].fields.text);

			assert(record.errors[0].event.type === "tick", "Wrong incident event");
			assert(record.errors[0].event.id === tickId, "Tick identity was lost");
		} else {
			assert(registry.note.data.value === 42, "Tick changes did not commit");
			assert(journals.length === 0, "Completed tick journal remained");
			assert(dispatcher.inspect().errors.length === 0, "Unexpected tick errors");
		}
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

async function testPersistentReportChain(tw, mode) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var top = "$:/clerus/jobs/report-chain-top";
	var manager = "$:/clerus/jobs/report-chain-manager";
	var worker = "$:/clerus/jobs/report-chain-worker";
	var project = "Persistent Report Chain Project";

	var reportInOrderRefused = false;
	var tickCount = 0;
	var topReportCount = 0;
	var managerReportCount = 0;
	var originalFlowFinished = false;
	var reportFlows = [];
	var signatures = [];
	var savedIncoming = null;

	var mission = linkedMissionFactory(project, [
		["department"],
		["department", "worker"]
	]);

	function addJob(title, executor, registry, phase) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(Object.assign({
				charter: {
					form: "charter",
					status: { phase: phase }
				}
			}, registry))
		}));
	}

	function recordReport(event) {
		signatures.push({
			project: event.project,
			role: event.role.slice()
		});

		wiki.each(function (tiddler, title) {
			if (tiddler.fields["clerus-wal-kind"] !== "flow") {
				return;
			}

			var record = JSON.parse(tiddler.fields.text);

			if (record.pending.some(function (message) {
				return message.id === event.id;
			})) {
				reportFlows.push(title);
			}
		});
	}

	function topReact(event, operational, incoming) {
		if (
			event.type === "ready" &&
			operational.get("charter").status().phase === "initial"
		) {
			operational.get("manager").order({
				instruction: "instruction"
			});
			operational.get("charter").setStatus({ phase: "sent" });
			return;
		}

		if (event.type !== "report") {
			return;
		}

		topReportCount++;
		recordReport(event);

		incoming.get("summary").file("finalResult");
		operational.get("charter").setStatus({ phase: "received" });
	}

	function managerReact(event, operational, incoming) {
		if (event.type === "order") {
			incoming.get("instruction").file("instruction");

			operational.get("worker").order({
				instruction: "instruction"
			});

			operational.get("charter").setStatus({ phase: "delegated" });
			return;
		}

		if (event.type !== "report") {
			return;
		}

		managerReportCount++;
		recordReport(event);

		savedIncoming = incoming.get("summary");
		savedIncoming.file("workerResult");

		// The newly filed memo is visible to this same reaction.
		operational.get("mission").report({
			summary: "workerResult"
		});

		operational.get("charter").setStatus({ phase: "forwarded" });

		if (mode === "failure") {
			throw new Error("Deliberate report forwarding failure");
		}
	}

	function workerReact(event, operational) {
		if (event.type === "order") {
			try {
				operational.get("mission").report({
					summary: "workingNote"
				});
			} catch (error) {
				reportInOrderRefused =
					String(error.message).indexOf(
						"Cannot report while reacting to an order"
					) !== -1;
			}

			operational.get("charter").defer();
			operational.get("charter").defer();
			operational.get("charter").setStatus({ phase: "waiting" });
			return;
		}

		if (event.type !== "tick") {
			return;
		}

		tickCount++;

		var flows = [];

		wiki.each(function (tiddler) {
			if (tiddler.fields["clerus-wal-kind"] === "flow") {
				flows.push(tiddler);
			}
		});

		originalFlowFinished = flows.length === 0;

		operational.get("mission").report({
			summary: "workingNote"
		});

		operational.get("charter").setStatus({ phase: "reported" });
	}

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": "user",
		text: JSON.stringify({
			task: {},
			parts: {
				department: {
					task: {},
					parts: {
						worker: { task: {}, parts: {} }
					}
				}
			}
		})
	}));

	var projectBefore = effects.capture(wiki.getTiddler(project));
	var recovery = mode === "recovery";

	addJob(top, "report-chain-top", {
		mission: mission([]),
		manager: manager,
		instruction: {
			form: "memo",
			data: { action: "report" }
		}
	}, recovery ? "sent" : "initial");

	addJob(manager, "report-chain-manager", {
		mission: mission(["department"]),
		worker: worker
	}, recovery ? "delegated" : "initial");

	addJob(worker, "report-chain-worker", {
		mission: mission(["department", "worker"]),
		workingNote: {
			form: "memo",
			data: { result: 42 }
		}
	}, recovery ? "waiting" : "initial");

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "report-chain-top",
				browser: topReact,
				node: topReact
			},
			{
				name: "report-chain-manager",
				browser: managerReact,
				node: managerReact
			},
			{
				name: "report-chain-worker",
				browser: workerReact,
				node: workerReact
			}
		])
	});

	if (recovery) {
		deferredWal.record(dispatcher.flowWal, deferredEffects.create({
			id: "recovered-report-tick",
			recipient: {
				title: worker,
				executor: "report-chain-worker",
				platform: platform
			}
		}));
	}

	function registry(title) {
		return JSON.parse(wiki.getTiddler(title).fields.text);
	}

	runtime.start();

	try {
		dispatcher.start();

		await waitFor(function () {
			return mode === "failure"
				? wiki.getTiddler(manager).fields["clerus-custody"] === "user"
				: registry(top).charter.status.phase === "received";
		}, 2000);

		assert(tickCount === 1, "Wrong deferred tick count");
		assert(originalFlowFinished, "Reports continued the original order flow");
		assert(managerReportCount === 1, "Manager received duplicate reports");

		if (!recovery) {
			assert(reportInOrderRefused, "Order reaction was allowed to report");
		}

		assertThrows(function () {
			savedIncoming.data();
		}, "closed");

		assert(
			signatures[0].project === project &&
			signatures[0].role.join("/") === "department/worker",
			"Wrong worker report signature"
		);

		var journals = [];

		wiki.each(function (tiddler, title) {
			if (title.indexOf(dispatcher.wal.prefix) === 0) {
				journals.push(tiddler);
			}
		});

		if (mode === "failure") {
			assert(topReportCount === 0, "Failed forwarding emitted an outgoing report");
			assert(!registry(manager).workerResult, "Failed forwarding filed its input");
			assert(
				registry(manager).charter.status.phase === "suspended",
				"Failed manager was not suspended"
			);
			assert(journals.length === 1, "Failed report evidence was lost");

			var record = JSON.parse(journals[0].fields.text);

			assert(record.errors.length === 1, "Wrong report error count");
			assert(
				record.errors[0].message.message === "report" &&
				record.errors[0].message.role.join("/") === "department/worker",
				"Failed report lost its signature"
			);
		} else {
			assert(topReportCount === 1, "Top received duplicate reports");
			assert(registry(top).finalResult.data.result === 42, "Final memo was lost");
			assert(registry(manager).workerResult.data.result === 42, "Manager memo was lost");

			assert(
				signatures[1].project === project &&
				signatures[1].role.join("/") === "department",
				"Forwarded report used the child's signature"
			);
			assert(
				reportFlows.length === 2 &&
				reportFlows[0] === reportFlows[1],
				"Upward reports did not share one transactional flow"
			);
			assert(journals.length === 0, "Completed report flow remained");
			assert(dispatcher.inspect().errors.length === 0, "Unexpected report errors");
		}

		assert(registry(worker).workingNote.data.result === 42, "Sender lost its memo");
		assert(registry(worker).charter.status.phase === "reported", "Worker did not commit");
		assert(
			registry(top).mission &&
			registry(manager).mission &&
			registry(worker).mission,
			"Memo reporting transferred an assignment"
		);
		assert(
			JSON.stringify(effects.capture(wiki.getTiddler(project))) ===
				JSON.stringify(projectBefore),
			"Reporting modified the project"
		);
		assert(runtime.inspect().missions.valid, "Final assignments are invalid");
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

async function testPersistentAppointment(tw, mode) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = "$:/clerus/jobs/appointment-source";
	var target = source + "/worker";

	var orderCount = 0;
	var readyCount = 0;
	var orderId = null;
	var creationDeferred = false;

	var contract = {
		form: "contract",
		temp: false,
		executor: "appointed-worker",
		book: { instruction: "Initialize worker" }
	};

	wiki.addTiddler(new tw.Tiddler({
		title: source,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "appointment-source",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			mandate: contract
		})
	}));

	function founder(event, operational) {
		if (
			event.type !== "ready" ||
			operational.get("charter").status().phase !== "initial"
		) {
			return;
		}

		var title = operational.get("charter").createTitle(
			"worker",
			"worker"
		);

		title.order("mandate");

		creationDeferred = !wiki.tiddlerExists(target);

		operational.get("charter").setStatus({ phase: "appointed" });
	}

	function worker(event, operational) {
		if (event.type === "ready") {
			readyCount++;
			return;
		}

		if (event.type !== "order") {
			return;
		}

		orderCount++;
		orderId = event.id;

		operational.get("charter").setStatus({
			phase: "active",
			instruction: operational.get("charter").book().instruction
		});

		if (mode === "failure") {
			throw new Error("Deliberate appointment initialization failure");
		}
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "appointment-source",
				browser: founder,
				node: founder
			},
			{
				name: "appointed-worker",
				browser: worker,
				node: worker
			}
		])
	});

	var prepared = null;

	if (mode === "recovery") {
		prepared = new workPlans.WorkPlan({
			wiki: wiki,
			Wiki: tw.Wiki,
			Tiddler: tw.Tiddler
		});

		var registry = JSON.parse(wiki.getTiddler(source).fields.text);

		delete registry.mandate;
		registry.worker = target;
		registry.charter.status = { phase: "appointed" };

		prepared.patch(source, { text: JSON.stringify(registry) });

		var effect = appointmentEffects.create({
			id: "recovered-appointment",
			source: {
				title: source,
				executor: "appointment-source",
				platform: platform
			},
			recipient: {
				title: target,
				executor: "appointed-worker",
				platform: platform
			},
			contract: contract
		}, documentFlow.loadRules(moduleSource([])));

		prepared.appoint(effect);

		dispatcher.flowWal.register({
			title: source,
			executor: "appointment-source",
			persistent: true
		}, prepared.initial(source), prepared.export());

		// Stop after source update and birth, before registering the order.
		effects.apply(wiki, tw.Tiddler, prepared.export().effects[0]);
		appointmentEffects.materialize(wiki, tw.Tiddler, effect);
	}

	runtime.start();

	try {
		dispatcher.start();

		await waitFor(function () {
			var current = wiki.getTiddler(target);

			if (!current) {
				return false;
			}

			return mode === "failure"
				? current.fields["clerus-custody"] === "user"
				: !current.fields["clerus-start"];
		}, 2000);

		assert(orderCount === 1, "Wrong number of establishing orders");
		assert(readyCount === 0, "New worker received ready before establishment");

		if (mode !== "recovery") {
			assert(creationDeferred, "Appointment escaped planning");
		}

		var parent = JSON.parse(wiki.getTiddler(source).fields.text);
		var current = wiki.getTiddler(target);
		var registry = JSON.parse(current.fields.text);

		assert(!parent.mandate, "Transferred contract remained with source");
		assert(parent.worker === target, "Source lost the worker title");
		assert(
			orderId === current.fields["clerus-instance"] + "-order",
			"Birth and order identities are not linked"
		);

		if (mode === "failure") {
			assert(current.fields["clerus-start"], "Failed initialization was acknowledged");
			assert(
				registry.charter.status.phase === "suspended",
				"Failed newborn was not suspended"
			);
			assert(
				registry.charter.status.previous.phase === "created",
				"Failed initialization committed its status"
			);
		} else {
			assert(registry.charter.status.phase === "active", "Initialization did not commit");
			assert(
				registry.charter.status.instruction === "Initialize worker",
				"Contract book was lost"
			);
			assert(!current.fields["clerus-start"], "Initialization marker remained");
			assert(dispatcher.inspect().errors.length === 0, "Unexpected appointment errors");
		}

		assert(runtime.inspect().hierarchy.valid, "Final hierarchy is invalid");
	} finally {
		dispatcher.stop();
		runtime.stop();

		if (prepared) {
			prepared.abort();
		}
	}
}

async function testPersistentAssignedAppointment(tw, mode) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = "$:/clerus/jobs/assigned-appointment-source";
	var target = source + "/worker";
	var project = "Assigned Appointment Project";

	var appointmentDeferred = false;
	var assignmentRevoked = false;
	var aliasRevoked = false;
	var assignedTaskReadable = false;
	var readyCount = 0;

	var mission = linkedMissionFactory(
		project,
		mode === "aliases" ? [["worker"]] : []
	);

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: { name: "root" },
			parts: mode === "aliases"
				? {
					worker: {
						task: { name: "worker" },
						parts: {}
					}
				}
				: {}
		})
	}));

	var sourceRegistry = {
		charter: {
			form: "charter",
			status: { phase: "initial" }
		},
		mission: mission([]),
		mandate: {
			form: "contract",
			temp: false,
			executor: "assigned-worker"
		}
	};

	if (mode === "aliases") {
		sourceRegistry.childMission = mission(["worker"]);
		sourceRegistry.alias = mission(["worker"]);
	}

	wiki.addTiddler(new tw.Tiddler({
		title: source,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "assigned-founder",
		text: JSON.stringify(sourceRegistry)
	}));

	function founder(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var root = operational.get("mission");
		var assignment;

		if (mode === "aliases") {
			assignment = operational.get("childMission");
		} else {
			root.createPart("worker", { name: "worker" });
			assignment = root.createMission("worker", "childMission");
		}

		var alias = mode === "aliases"
			? operational.get("alias")
			: null;

		if (mode === "staffed") {
			assignment.createPart("item", { name: "item" });
			assignment.createMission("item", "grandchild");
		}

		var recipient = operational.get("charter").createTitle(
			"worker",
			"worker"
		);

		recipient.order("mandate", "childMission");

		appointmentDeferred = !wiki.tiddlerExists(target);

		try {
			assignment.inspect();
		} catch (error) {
			assignmentRevoked =
				String(error.message).indexOf("no longer") !== -1;
		}

		if (alias) {
			try {
				alias.inspect();
			} catch (error) {
				aliasRevoked =
					String(error.message).indexOf("no longer") !== -1;
			}
		}

		operational.get("charter").setStatus({ phase: "appointed" });
	}

	function worker(event, operational) {
		if (event.type === "ready") {
			readyCount++;
			return;
		}

		if (event.type !== "order") {
			return;
		}

		assignedTaskReadable =
			operational.get("mission").task().name === "worker";

		operational.get("charter").setStatus({ phase: "active" });

		if (mode === "failure") {
			throw new Error("Deliberate assigned worker initialization failure");
		}
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "assigned-founder",
				browser: founder,
				node: founder
			},
			{
				name: "assigned-worker",
				browser: worker,
				node: worker
			}
		])
	});

	runtime.start();

	try {
		dispatcher.start();

		await waitFor(function () {
			var current = wiki.getTiddler(target);

			return current && (
				mode === "failure"
					? current.fields["clerus-custody"] === "user"
					: !current.fields["clerus-start"]
			);
		}, 2000);

		var parent = JSON.parse(wiki.getTiddler(source).fields.text);

		assert(parent.mission.role.length === 0, "Sender lost the parent role");

		assert(appointmentDeferred, "Assignment appointment escaped planning");
		assert(assignmentRevoked, "Transferred assignment form remained usable");
		assert(!parent.childMission && !parent.alias, "Sender retained an assignment copy");
		assert(!parent.mandate, "Sender retained the consumed contract");
		assert(assignedTaskReadable, "New worker could not read its assigned task");
		assert(readyCount === 0, "New worker received ready before establishment");

		if (mode === "aliases") {
			assert(aliasRevoked, "Transferred alias form remained usable");
		}

		var child = JSON.parse(wiki.getTiddler(target).fields.text);

		assert(child.mission.role.join("/") === "worker", "Wrong received role");

		if (mode === "failure") {
			assert(
				child.charter.status.phase === "suspended",
				"Failed assigned worker was not suspended"
			);
			assert(child.mission, "Initialization failure removed the assignment");
		} else {
			assert(child.charter.status.phase === "active", "Initialization did not commit");
			assert(dispatcher.inspect().errors.length === 0, "Unexpected assignment errors");
		}

		if (mode === "staffed") {
			assert(parent.grandchild, "Transfer physically removed the lower assignment");

			var lower = missions.read(
				wiki,
				runtime.inspect().jobs,
				source,
				parent.grandchild
			);

			assert(!lower.active, "Lower assignment retained invalid subordination");
			assert(!lower.readable, "Inactive lower assignment retained task access");
		}

		assert(runtime.inspect().missions.valid, "Final assignments are invalid");
		assert(runtime.inspect().hierarchy.valid, "Final hierarchy is invalid");
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

async function testAssignedAppointmentRecovery(tw, stage) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = "$:/clerus/jobs/assigned-recovery-source";
	var target = source + "/worker";
	var project = "Assigned Recovery Project";

	var orderCount = 0;
	var readyCount = 0;
	var sourceSawRecoveredState = false;
	var assignedTaskReadable = false;
	var savedAssignment = null;

	var mission = linkedMissionFactory(project, [["worker"]]);

	var contract = {
		form: "contract",
		temp: false,
		executor: "assigned-recovery-worker",
		book: {
			instruction: "Initialize recovered assignment"
		}
	};

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: { name: "root" },
			parts: {
				worker: {
					task: { name: "worker" },
					parts: {}
				}
			}
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: source,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "assigned-recovery-source",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			mission: mission([]),
			childMission: mission(["worker"]),
			alias: mission(["worker"]),
			worker: target,
			mandate: contract
		})
	}));

	var rootPlan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	var sourceRegistry = JSON.parse(wiki.getTiddler(source).fields.text);

	delete sourceRegistry.mandate;
	delete sourceRegistry.childMission;
	delete sourceRegistry.alias;
	sourceRegistry.charter.status = { phase: "appointed" };

	rootPlan.patch(source, {
		text: JSON.stringify(sourceRegistry)
	});

	var appointment = appointmentEffects.create({
		id: "assigned-recovery-birth",
		source: {
			title: source,
			executor: "assigned-recovery-source",
			platform: platform
		},
		recipient: {
			title: target,
			executor: "assigned-recovery-worker",
			platform: platform
		},
		contract: contract,
		mission: mission(["worker"])
	}, documentFlow.loadRules(moduleSource([])));

	rootPlan.appoint(appointment);

	var flow = new FlowWal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () {
			return "assigned-recovery-flow";
		}
	});

	var journalTitle = flow.register({
		title: source,
		executor: "assigned-recovery-source",
		persistent: true
	}, rootPlan.initial(source), rootPlan.export());

	var initializationPlan = null;

	if (stage === "source-only" || stage === "born") {
		effects.apply(wiki, tw.Tiddler, rootPlan.export().effects[0]);

		if (stage === "born") {
			appointmentEffects.materialize(wiki, tw.Tiddler, appointment);
		}
	} else {
		var messages = flow.resume(journalTitle);

		assert(messages.length === 1, "Establishing message was not registered");

		initializationPlan = new workPlans.WorkPlan({
			wiki: wiki,
			Wiki: tw.Wiki,
			Tiddler: tw.Tiddler
		});

		var childRegistry = JSON.parse(wiki.getTiddler(target).fields.text);

		childRegistry.charter.status = {
			phase: "active",
			instruction: childRegistry.charter.book.instruction
		};

		initializationPlan.patch(target, {
			text: JSON.stringify(childRegistry),
			"clerus-start": undefined
		});

		flow.accept(
			journalTitle,
			appointment.id + "-order",
			{
				title: target,
				executor: "assigned-recovery-worker",
				persistent: true
			},
			initializationPlan.initial(target),
			initializationPlan.export()
		);

		if (stage === "initialized") {
			workPlans.materialize(
				wiki,
				tw.Tiddler,
				initializationPlan.export()
			);
		}
	}

	// Rebuild only the materialized wiki state.
	var restarted = new tw.Wiki();

	wiki.each(function (tiddler) {
		restarted.addTiddler(new tw.Tiddler(effects.capture(tiddler)));
	});

	function sourceReact(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var keys = operational.keys();

		sourceSawRecoveredState =
			operational.get("charter").status().phase === "appointed" &&
			keys.indexOf("mandate") === -1 &&
			keys.indexOf("childMission") === -1 &&
			keys.indexOf("alias") === -1;
	}

	function workerReact(event, operational) {
		if (event.type === "ready") {
			readyCount++;

			assignedTaskReadable =
				operational.get("mission").task().name === "worker";

			savedAssignment = operational.get("mission");
			return;
		}

		if (event.type !== "order") {
			return;
		}

		orderCount++;
		savedAssignment = operational.get("mission");

		assignedTaskReadable =
			savedAssignment.task().name === "worker";

		operational.get("charter").setStatus({
			phase: "active",
			instruction: operational.get("charter").book().instruction
		});
	}

	var runtime = new Runtime({
		wiki: restarted,
		platform: platform
	});

	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "assigned-recovery-source",
				browser: sourceReact,
				node: sourceReact
			},
			{
				name: "assigned-recovery-worker",
				browser: workerReact,
				node: workerReact
			}
		])
	});

	runtime.start();

	try {
		dispatcher.start();

		await waitFor(function () {
			var child = restarted.getTiddler(target);

			return child &&
				!child.fields["clerus-start"] &&
				!restarted.tiddlerExists(journalTitle);
		}, 2000);

		var parent = JSON.parse(restarted.getTiddler(source).fields.text);
		var child = restarted.getTiddler(target);
		var registry = JSON.parse(child.fields.text);

		assert(sourceSawRecoveredState, "Source activated before transfer recovery");
		assert(assignedTaskReadable, "Recovered assignment was not readable");

		assert(!parent.mandate, "Consumed contract reappeared");
		assert(!parent.childMission && !parent.alias, "Transferred assignment reappeared");
		assert(parent.mission.role.length === 0, "Parent role was lost");
		assert(parent.worker === target, "Recipient title was lost");

		assert(
			child.fields["clerus-instance"] === appointment.id,
			"Recovery changed the recipient instance identity"
		);
		assert(!child.fields["clerus-start"], "Initialization remains incomplete");
		assert(registry.mission.role.join("/") === "worker", "Wrong recovered role");
		assert(registry.charter.status.phase === "active", "Wrong recovered status");
		assert(
			registry.charter.status.instruction ===
				"Initialize recovered assignment",
			"Recovered charter lost its instruction"
		);

		var accepted = stage === "accepted" || stage === "initialized";

		assert(
			orderCount === (accepted ? 0 : 1),
			"Recovery reran an accepted initialization or lost its order"
		);
		assert(
			readyCount === (accepted ? 1 : 0),
			"Wrong boot activation after initialization recovery"
		);

		assertThrows(function () {
			savedAssignment.inspect();
		}, "closed");

		assert(runtime.inspect().missions.valid, "Recovered assignments are invalid");
		assert(runtime.inspect().hierarchy.valid, "Recovered hierarchy is invalid");
		assert(dispatcher.inspect().errors.length === 0, "Unexpected recovery errors");
	} finally {
		dispatcher.stop();
		runtime.stop();
		rootPlan.abort();

		if (initializationPlan) {
			initializationPlan.abort();
		}
	}
}

async function testPersistentStaffedAppointment(tw, mode) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = "$:/clerus/jobs/staffed-appointment-source";
	var target = source + "/replacement";
	var staff = "$:/clerus/jobs/staffed-appointment-worker";
	var leaf = "$:/clerus/jobs/staffed-appointment-leaf";
	var project = "Persistent Staffed Appointment Project";

	var transferRefused = false;
	var recipientInspectedTransfer = false;

	var mission = linkedMissionFactory(project, [
		["department"],
		["department", "worker"],
		["department", "worker", "item"]
	]);

	var contract = {
		form: "contract",
		temp: false,
		executor: "staffed-replacement",
		book: { instruction: "Take over the staffed department" }
	};

	function addJob(title, executor, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(Object.assign({
				charter: {
					form: "charter",
					status: { phase: "working" }
				}
			}, registry))
		}));
	}

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: { name: "root" },
			parts: {
				department: {
					task: { name: "department" },
					parts: {
						worker: {
							task: { name: "worker" },
							parts: {
								item: {
									task: { name: "item" },
									parts: {}
								}
							}
						}
					}
				}
			}
		})
	}));

	addJob(source, "staffed-founder", {
		charter: {
			form: "charter",
			status: { phase: "initial" }
		},
		mission: mission([]),
		department: mission(["department"]),
		knownStaff: staff,
		mandate: contract
	});

	addJob(staff, "staffed-employee", {
		mission: mission(["department", "worker"]),
		subordinate: leaf,
		note: { form: "memo", data: "staff evidence" }
	});

	addJob(leaf, "staffed-employee", {
		mission: mission(["department", "worker", "item"]),
		note: { form: "memo", data: "leaf evidence" }
	});

	var staffBefore = effects.capture(wiki.getTiddler(staff));
	var leafBefore = effects.capture(wiki.getTiddler(leaf));
	var projectBefore = effects.capture(wiki.getTiddler(project));

	function founder(event, operational) {
		if (
			event.type !== "ready" ||
			operational.get("charter").status().phase !== "initial"
		) {
			return;
		}

		var replacement = operational.get("charter").createTitle(
			"replacement",
			"replacement"
		);

		replacement.order(
			"mandate",
			"department",
			mode === "without-titles" ? {} : { staff: "knownStaff" }
		);

		operational.get("charter").setStatus({ phase: "appointed" });
	}

	function replacementReact(event, operational) {
		if (event.type !== "order") {
			return;
		}

		assert(
			operational.get("mission").task().name === "department",
			"Transferred task is unreadable"
		);

		if (mode === "without-titles") {
			assert(
				operational.keys().indexOf("staff") === -1,
				"Unselected staff title reached the recipient"
			);
			recipientInspectedTransfer = true;
		} else {
			recipientInspectedTransfer =
				operational.get("staff").status().phase === "working";
		}

		operational.get("charter").setStatus({ phase: "active" });
	}

	function employee(event) {}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "staffed-founder",
				browser: founder,
				node: founder
			},
			{
				name: "staffed-replacement",
				browser: replacementReact,
				node: replacementReact
			},
			{
				name: "staffed-employee",
				browser: employee,
				node: employee
			}
		])
	});

	var prepared = null;

	if (mode === "recovery") {
		prepared = new workPlans.WorkPlan({
			wiki: wiki,
			Wiki: tw.Wiki,
			Tiddler: tw.Tiddler
		});

		var preparedRegistry = JSON.parse(
			wiki.getTiddler(source).fields.text
		);

		delete preparedRegistry.mandate;
		delete preparedRegistry.department;
		preparedRegistry.replacement = target;
		preparedRegistry.charter.status = { phase: "appointed" };

		prepared.patch(source, {
			text: JSON.stringify(preparedRegistry)
		});

		var appointment = appointmentEffects.create({
			id: "recovered-staffed-birth",
			source: {
				title: source,
				executor: "staffed-founder",
				platform: platform
			},
			recipient: {
				title: target,
				executor: "staffed-replacement",
				platform: platform
			},
			contract: contract,
			mission: mission(["department"]),
			titles: { staff: staff }
		}, documentFlow.loadRules(moduleSource([])));

		prepared.appoint(appointment);

		dispatcher.flowWal.register({
			title: source,
			executor: "staffed-founder",
			persistent: true
		}, prepared.initial(source), prepared.export());

		// Stop after birth, before registering its establishing order.
		effects.apply(wiki, tw.Tiddler, prepared.export().effects[0]);
		appointmentEffects.materialize(wiki, tw.Tiddler, appointment);
	}

	function registry(title) {
		return JSON.parse(wiki.getTiddler(title).fields.text);
	}

	runtime.start();

	try {
		dispatcher.start();

		await waitFor(function () {
			return wiki.tiddlerExists(target) &&
				!wiki.getTiddler(target).fields["clerus-start"];
		}, 2000);

		var parent = registry(source);

		assert(parent.knownStaff === staff, "Copied title disappeared from source");
		assert(parent.mission.role.length === 0, "Source lost its parent role");

		var received = registry(target);

		assert(!parent.mandate && !parent.department, "Transfer did not consume documents");
		assert(
			received.mission.role.join("/") === "department",
			"Recipient received the wrong role"
		);
		assert(recipientInspectedTransfer, "Recipient could not inspect its transfer");
		assert(received.charter.status.phase === "active", "Initialization failed");

		if (mode === "without-titles") {
			assert(!received.staff, "Unselected title reached the recipient");
		} else {
			assert(received.staff === staff, "Recipient did not receive the staff title");
		}

		var jobs = runtime.inspect().jobs;

		assert(
			missions.read(wiki, jobs, staff, registry(staff).mission).active ===
				(mode !== "without-titles"),
			"Wrong worker authority after transfer"
		);
		assert(
			missions.read(wiki, jobs, leaf, registry(leaf).mission).active ===
				(mode !== "without-titles"),
			"Wrong descendant authority after transfer"
		);

		assert(
			JSON.stringify(effects.capture(wiki.getTiddler(staff))) ===
				JSON.stringify(staffBefore),
			"Transfer modified the staff registry"
		);
		assert(
			JSON.stringify(effects.capture(wiki.getTiddler(leaf))) ===
				JSON.stringify(leafBefore),
			"Transfer modified a deeper registry"
		);
		assert(
			JSON.stringify(effects.capture(wiki.getTiddler(project))) ===
				JSON.stringify(projectBefore),
			"Transfer modified the project"
		);
		assert(runtime.inspect().missions.valid, "Final assignments are invalid");
		assert(runtime.inspect().hierarchy.valid, "Final hierarchy is invalid");
		assert(dispatcher.inspect().errors.length === 0, "Unexpected staffing errors");
	} finally {
		dispatcher.stop();
		runtime.stop();

		if (prepared) {
			prepared.abort();
		}
	}
}

function linkedMissionFixture() {
	var project = "Linked Mission Project";
	var A = "$:/clerus/jobs/linked-a";
	var B = "$:/clerus/jobs/linked-b";
	var C = "$:/clerus/jobs/linked-c";

	function mission(role, link, children) {
		return {
			form: "mission",
			project: project,
			role: role,
			link: link,
			issued: "0",
			children: children || {}
		};
	}

	return {
		project: project,
		A: A,
		B: B,
		C: C,
		mission: mission,
		jobs: [
			{
				title: A,
				persistent: true,
				registry: {
					mission: mission([], "10", { department: "11" }),
					subordinate: B
				}
			},
			{
				title: B,
				persistent: true,
				registry: {
					mission: mission(["department"], "11", { worker: "12" }),
					subordinate: C
				}
			},
			{
				title: C,
				persistent: true,
				registry: {
					mission: mission(["department", "worker"], "12")
				}
			}
		]
	};
}

function testLinkedSubtreeRevocation() {
	var fixture = linkedMissionFixture();
	var jobs = fixture.jobs;

	assert(missionLinks.evaluate(jobs).active.length === 3, "Initial chain is inactive");

	var lowerBefore = JSON.stringify(jobs.slice(1));

	jobs[0].registry.mission.children.department = "13";

	var revoked = missionLinks.evaluate(jobs);

	assert(revoked.active.length === 1, "Old subtree remained active");
	assert(
		JSON.stringify(jobs.slice(1)) === lowerBefore,
		"Revocation modified lower registries"
	);

	// Matching lower pairs do not rescue a broken path to the root.
	assert(
		revoked.entries.filter(function (entry) {
			return entry.title === fixture.C;
		})[0].active === false,
		"Grandchild survived a revoked ancestor"
	);
}

function testLinkedParentTransfer() {
	var fixture = linkedMissionFixture();
	var jobs = fixture.jobs;
	var replacement = "$:/clerus/jobs/linked-replacement";
	var lowerBefore = JSON.stringify(jobs.slice(1));

	jobs.push({
		title: replacement,
		persistent: true,
		registry: {
			mission: JSON.parse(JSON.stringify(jobs[0].registry.mission)),
			subordinate: fixture.B
		}
	});

	assert(
		missionLinks.evaluate(jobs).active.length === 0,
		"Two holders of the selected root were accepted"
	);

	delete jobs[0].registry.mission;

	var transferred = missionLinks.evaluate(jobs);

	assert(transferred.active.length === 3, "Transferred parent broke its children");
	assert(
		JSON.stringify(jobs.slice(1, 3)) === lowerBefore,
		"Transfer rewrote child assignments"
	);
	assert(
		transferred.active.some(function (entry) {
			return entry.title === replacement && entry.role.length === 0;
		}),
		"Replacement did not become the root holder"
	);
}

function testLinkedRootSelection() {
	var fixture = linkedMissionFixture();
	var jobs = fixture.jobs;
	var newer = "$:/clerus/jobs/newer-linked-root";

	// Numeric order, not ordinary lexicographic order.
	jobs[0].registry.mission.link = "9";

	jobs.push({
		title: newer,
		persistent: true,
		registry: {
			mission: fixture.mission([], "10")
		}
	});

	var selected = missionLinks.evaluate(jobs);

	assert(selected.active.length === 1, "Old root subtree remained active");
	assert(selected.active[0].title === newer, "Wrong root label was selected");

	// Prototype policy: deleting the newest root exposes the old one.
	jobs.pop();

	assert(
		missionLinks.evaluate(jobs).active.length === 3,
		"Newest-present root policy was not applied"
	);

	assert(
		missionLinks.compareLabels(
			"999999999999999999999999",
			"1000000000000000000000000"
		) < 0,
		"Large labels were compared incorrectly"
	);
}

function testLinkedAssignmentCopies() {
	var fixture = linkedMissionFixture();
	var jobs = fixture.jobs;

	jobs[1].registry.alias = JSON.parse(
		JSON.stringify(jobs[1].registry.mission)
	);

	assert(
		missionLinks.evaluate(jobs).active.length === 3,
		"Aliases within one holder caused ambiguity"
	);

	jobs[1].registry.alias.children.worker = "99";

	var conflicting = missionLinks.evaluate(jobs);

	assert(conflicting.active.length === 1, "Divergent aliases remained active");

	jobs[1].registry.alias.children.worker = "12";

	jobs.push({
		title: "$:/clerus/jobs/duplicate-linked-holder",
		persistent: true,
		registry: {
			mission: JSON.parse(JSON.stringify(jobs[1].registry.mission))
		}
	});

	var ambiguous = missionLinks.evaluate(jobs);

	assert(ambiguous.active.length === 1, "Different holders shared an active grant");
	assert(
		ambiguous.issues.some(function (issue) {
			return issue.type === "ambiguous-holder";
		}),
		"Holder ambiguity was not diagnosed"
	);
}

function testLinkedSubordination() {
	var fixture = linkedMissionFixture();

	delete fixture.jobs[0].registry.subordinate;

	var result = missionLinks.evaluate(fixture.jobs);

	assert(result.active.length === 1, "Labels bypassed subordination");
	assert(
		result.entries.some(function (entry) {
			return entry.title === fixture.B &&
				entry.reason === "invalid-subordination";
		}),
		"Missing superior relation was not diagnosed"
	);
}

function testLinkedIssuanceAliases() {
	var fixture = linkedMissionFixture();
	var registry = fixture.jobs[0].registry;

	registry.alias = JSON.parse(JSON.stringify(registry.mission));

	var before = JSON.stringify(registry);

	var first = missionIssuance.issue(
		registry,
		"mission",
		"new",
		"newMission"
	);

	assert(JSON.stringify(registry) === before, "Issuance mutated its input");
	assert(first.link === "10/1", "Wrong first issued label");
	assert(first.registry.mission.issued === "1", "Counter was not advanced");
	assert(first.registry.alias.issued === "1", "Alias counter was not advanced");
	assert(
		first.registry.alias.children.new === first.link,
		"Alias binding was not updated"
	);
	assert(
		first.registry.mission.children.department === "11",
		"Unrelated binding was lost"
	);

	var second = missionIssuance.issue(
		first.registry,
		"alias",
		"another",
		"anotherMission"
	);

	assert(second.link === "10/2", "Issuance through an alias reused the counter");

	fixture.jobs[0].registry = second.registry;

	assert(
		missionLinks.evaluate(fixture.jobs).active.length === 5,
		"Issued assignments did not join the active tree"
	);
}

function testLinkedIssuanceAfterRevocation() {
	var fixture = linkedMissionFixture();

	var first = missionIssuance.issue(
		fixture.jobs[0].registry,
		"mission",
		"department",
		"first"
	);

	var stale = first.registry.first;
	var revoked = missionIssuance.revoke(
		first.registry,
		"mission",
		"department"
	);

	assert(revoked.registry.mission.issued === "1", "Revocation reset the counter");
	assert(
		!Object.prototype.hasOwnProperty.call(
			revoked.registry.mission.children, "department"
		),
		"Binding was not revoked"
	);

	// Physical cleanup must not erase issuance history.
	delete revoked.registry.first;

	var second = missionIssuance.issue(
		revoked.registry,
		"mission",
		"department",
		"second"
	);

	assert(second.link === "10/2", "Revoked label was reused");

	// Even a later reappearance of the old document must not reactivate it.
	second.registry.stale = stale;
	fixture.jobs[0].registry = second.registry;

	var result = missionLinks.evaluate(fixture.jobs);

	assert(
		result.entries.some(function (entry) {
			return entry.key === "stale" && !entry.active;
		}),
		"Old assignment became active again"
	);
	assert(result.active.length === 2, "Old descendants survived replacement");
}

function testLinkedNestedIssuance() {
	var fixture = linkedMissionFixture();

	var first = missionIssuance.issue(
		fixture.jobs[0].registry,
		"mission",
		"new",
		"child"
	);

	var nested = missionIssuance.issue(
		first.registry,
		"child",
		"item",
		"grandchild"
	);

	assert(nested.link === "10/1/1", "Wrong nested issuance namespace");
	assert(
		nested.registry.mission.issued === "1",
		"Nested issuance advanced the wrong counter"
	);

	nested.registry.mission.issued = "99999999999999999999";

	var large = missionIssuance.issue(
		nested.registry,
		"mission",
		"large",
		"largeMission"
	);

	assert(
		large.link === "10/100000000000000000000",
		"Large issuance counter lost precision"
	);

	fixture.jobs[0].registry = large.registry;

	assert(
		missionLinks.evaluate(fixture.jobs).active.length === 6,
		"Nested issued assignments were not active"
	);
}

function testLinkedIssuanceConflict() {
	var fixture = linkedMissionFixture();
	var registry = fixture.jobs[0].registry;

	registry.alias = JSON.parse(JSON.stringify(registry.mission));
	registry.alias.issued = "1";

	var before = JSON.stringify(registry);

	assertThrows(function () {
		missionIssuance.issue(registry, "mission", "new", "child");
	}, "conflicting aliases");

	assertThrows(function () {
		missionIssuance.revoke(registry, "mission", "department");
	}, "conflicting aliases");

	assert(JSON.stringify(registry) === before, "Failed issuance changed its input");
	assert(
		missionLinks.evaluate(fixture.jobs).active.length === 0,
		"Conflicting counter copies remained authoritative"
	);
}

function testLinkedRuntimeIssuance(tw, persistent) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = persistent
		? "$:/clerus/jobs/linked-runtime-test"
		: "$:/temp/clerus/jobs/" + platform + "/linked-runtime-test";
	var project = "Linked Runtime Project";

	var root = {
		form: "mission",
		project: project,
		role: [],
		link: "10",
		issued: "0",
		children: {}
	};

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: { name: "root" },
			parts: {}
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "linked-runtime-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			mission: root,
			alias: JSON.parse(JSON.stringify(root))
		})
	}));

	var staleDenied = false;
	var replacementReadable = false;

	function react(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var parent = operational.get("mission");

		parent.createPart("worker", { name: "worker" });

		var first = parent.createMission("worker", "first");

		first.createPart("item", { name: "item" });
		first.createMission("item", "oldGrandchild");

		parent.revokePart("worker");

		try {
			first.task();
		} catch (error) {
			staleDenied = !first.inspect().active;
		}

		var replacement = parent.createMission("worker", "replacement");
		var grandchild = replacement.createMission("item", "newGrandchild");

		replacementReadable =
			replacement.task().name === "worker" &&
			grandchild.task().name === "item";

		operational.get("charter").setStatus({ phase: "complete" });
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "linked-runtime-test",
				browser: react,
				node: react
			}
		])
	});

	runtime.start();

	try {
		dispatcher.start();

		var registry = JSON.parse(wiki.getTiddler(title).fields.text);
		var perspective = missionLinks.evaluate(runtime.inspect().jobs);

		assert(staleDenied, "Revoked assignment retained task access");
		assert(replacementReadable, "Replacement assignments were not readable");

		assert(registry.first, "Revocation physically removed the old assignment");
		assert(registry.oldGrandchild, "Revocation physically removed its descendant");

		assert(registry.mission.issued === "2", "Parent counter was reset");
		assert(registry.alias.issued === "2", "Parent alias was not updated");
		assert(
			registry.mission.children.worker === registry.replacement.link,
			"Upper binding does not select the replacement"
		);

		assert(perspective.active.length === 3, "Wrong active assignment count");
		assert(
			perspective.entries.some(function (entry) {
				return entry.key === "first" && !entry.active;
			}),
			"Old assignment was not recognized as inactive"
		);
		assert(
			perspective.entries.some(function (entry) {
				return entry.key === "oldGrandchild" && !entry.active;
			}),
			"Old descendant remained active"
		);

		assert(
			registry.charter.status.phase === "complete",
			"Registry changes did not commit"
		);
		assert(dispatcher.inspect().errors.length === 0, "Unexpected linked-runtime errors");
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testLinkedMissionObservation(tw) {
	var fixture = linkedMissionFixture();
	var wiki = new tw.Wiki();
	var observer = new StatusObserver();
	var jobs = fixture.jobs;

	wiki.addTiddler(new tw.Tiddler({
		title: fixture.project,
		type: "application/json",
		text: JSON.stringify({
			task: { name: "root" },
			parts: {
				department: {
					task: { name: "department" },
					parts: {
						worker: {
							task: { name: "worker" },
							parts: {}
						}
					}
				}
			}
		})
	}));

	function collect() {
		return observer.collect(
			jobs,
			function () {
				return {
					readable: true,
					status: {}
				};
			},
			function (holder, document) {
				return missions.read(
					wiki,
					jobs,
					holder,
					document
				);
			},
			function () {
				throw new Error("Unexpected ordinary tiddler subscription");
			}
		);
	}

	function missionEvents(events) {
		return events.filter(function (event) {
			return event.key === "mission";
		});
	}

	assert(collect().length === 0, "Initial observation emitted events");

	var lowerBefore = JSON.stringify(jobs.slice(1));

	delete jobs[0].registry.mission.children.department;

	var revoked = missionEvents(collect());

	assert(revoked.length === 2, "Revocation did not notify both descendants");
	assert(
		revoked.some(function (event) {
			return event.recipient === fixture.B;
		}),
		"Immediate child was not notified"
	);
	assert(
		revoked.some(function (event) {
			return event.recipient === fixture.C;
		}),
		"Deeper descendant was not notified"
	);
	assert(
		JSON.stringify(jobs.slice(1)) === lowerBefore,
		"Observation or revocation changed lower registries"
	);
	assert(collect().length === 0, "Unchanged inactive state emitted events");

	jobs[0].registry.mission.children.department = "11";

	var restored = missionEvents(collect());

	assert(restored.length === 2, "Restoration did not notify both descendants");
	assert(collect().length === 0, "Unchanged active state emitted events");

	// Establish an inactive baseline.
	delete jobs[0].registry.mission.children.department;
	collect();

	// Replacing a document under the same key starts a new subscription.
	jobs[1].registry.mission.link = "99";

	var replaced = missionEvents(collect());

	assert(
		!replaced.some(function (event) {
			return event.recipient === fixture.B;
		}),
		"Replacement inherited another document's observation history"
	);
}

async function testLinkedAppointmentTransfer(tw, persistent) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = persistent
		? "$:/clerus/jobs/"
		: "$:/temp/clerus/jobs/" + platform + "/";
	var source = prefix + "linked-appointment-source";
	var target = source + "/worker";
	var project = "Linked Appointment Project";
	var revoked = false;
	var aliasRevoked = false;
	var initialized = false;

	function mission(role, link, issued, children) {
		return {
			form: "mission",
			project: project,
			role: role,
			link: link,
			issued: issued,
			children: children
		};
	}

	var child = mission(["worker"], "10/2", "7", {});
	var stale = mission(["worker"], "10/1", "0", {});

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: {},
			parts: {
				worker: {
					task: { name: "worker" },
					parts: {}
				}
			}
		})
	}));

	var projectBefore = effects.capture(wiki.getTiddler(project));

	wiki.addTiddler(new tw.Tiddler({
		title: source,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "linked-appointment-founder",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			root: mission([], "10", "2", { worker: "10/2" }),
			child: child,
			alias: JSON.parse(JSON.stringify(child)),
			stale: stale,
			mandate: {
				form: "contract",
				temp: !persistent,
				executor: "linked-appointment-worker"
			}
		})
	}));

	function founder(event, operational) {
		if (
			event.type !== "ready" ||
			operational.get("charter").status().phase !== "initial"
		) {
			return;
		}

		var assignment = operational.get("child");
		var alias = operational.get("alias");
		var recipient = operational.get("charter").createTitle(
			"worker",
			"worker"
		);

		recipient.order("mandate", "child");

		try {
			assignment.inspect();
		} catch (error) {
			revoked = String(error.message).indexOf("no longer") !== -1;
		}

		try {
			alias.inspect();
		} catch (error) {
			aliasRevoked = String(error.message).indexOf("no longer") !== -1;
		}

		assert(
			!operational.get("stale").inspect().active,
			"Old generation became active"
		);

		operational.get("charter").setStatus({ phase: "sent" });
	}

	function worker(event, operational) {
		if (event.type !== "order") {
			return;
		}

		assert(
			operational.get("mission").task().name === "worker",
			"Transferred task is unreadable"
		);

		operational.get("charter").setStatus({ phase: "active" });
		initialized = true;
	}

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "linked-appointment-founder",
				browser: founder,
				node: founder
			},
			{
				name: "linked-appointment-worker",
				browser: worker,
				node: worker
			}
		])
	});

	runtime.start();

	try {
		dispatcher.start();

		await waitFor(function () {
			return initialized ||
				dispatcher.inspect().errors.length > 0;
		}, 2000);

		assert(
			dispatcher.inspect().errors.length === 0,
			"Unexpected transfer errors: " +
				JSON.stringify(dispatcher.inspect().errors)
		);
		assert(initialized, "Recipient was not initialized");
		assert(revoked && aliasRevoked, "Transferred forms remained usable");

		var parent = JSON.parse(wiki.getTiddler(source).fields.text);
		var received = JSON.parse(wiki.getTiddler(target).fields.text);

		assert(!parent.child && !parent.alias, "Sender retained transferred aliases");
		assert(!parent.mandate, "Sender retained the contract");
		assert(
			JSON.stringify(parent.stale) === JSON.stringify(stale),
			"Transfer removed or changed another generation"
		);
		assert(
			JSON.stringify(received.mission) === JSON.stringify(child),
			"Transfer changed mission identity or issuance history"
		);
		assert(
			JSON.stringify(effects.capture(wiki.getTiddler(project))) ===
				JSON.stringify(projectBefore),
			"Transfer changed the project"
		);
		assert(runtime.inspect().missions.valid, "Final mission audit failed");
		assert(runtime.inspect().hierarchy.valid, "Final hierarchy audit failed");
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

async function testLinkedDetachmentLifecycle(tw, fail) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/";
	var parentTitle = prefix + "linked-lifecycle-parent";
	var childTitle = prefix + "linked-lifecycle-child";
	var project = "Linked Lifecycle Project";

	var mission = linkedMissionFactory(project, [
		["worker"],
		["worker", "item"]
	]);

	var unrelatedMission = linkedMissionFactory(
		"Unrelated Lifecycle Project",
		[]
	)([]);

	var parentReady = false;
	var childReady = false;
	var tickCount = 0;
	var childNotified = false;
	var dismissed = false;
	var dismissalWriteRefused = false;
	var sourceFormsRevoked = false;
	var previousContextClosed = false;
	var lowerUnchangedAtTransition = false;
	var childObservedInactive = false;
	var dismissalKeys = null;
	var oldChildMission = null;
	var childBefore = null;

	function parent(event, operational) {
		if (event.type === "ready") {
			parentReady = true;

			// The initial scan establishes observation baselines before
			// this independent tick performs the transition.
			operational.get("charter").defer();
			return;
		}

		if (event.type === "dismissed") {
			dismissed = true;
			dismissalKeys = event.keys.slice();

			assert(
				operational.keys().indexOf("mission") === -1 &&
					operational.keys().indexOf("alias") === -1,
				"Dismissed context retained removed assignments"
			);

			lowerUnchangedAtTransition =
				JSON.stringify(effects.capture(
					wiki.getTiddler(childTitle)
				)) === JSON.stringify(childBefore);

			try {
				operational.get("charter").setStatus({
					phase: "forbidden"
				});
			} catch (error) {
				dismissalWriteRefused =
					String(error.message).indexOf("read-only") !== -1;
			}

			return;
		}

		if (event.type !== "tick") {
			return;
		}

		tickCount++;

		assert(parentReady && childReady, "Transition preceded activation");
		assert(
			operational.get("mission").inspect().active,
			"Initial parent assignment is inactive"
		);

		if (fail) {
			throw new Error("Deliberate linked director failure");
		}

		var assignment = operational.get("mission");
		var alias = operational.get("alias");

		assignment.resign();

		var assignmentRevoked = false;
		var aliasRevoked = false;

		try {
			assignment.inspect();
		} catch (error) {
			assignmentRevoked =
				String(error.message).indexOf("no longer") !== -1;
		}

		try {
			alias.inspect();
		} catch (error) {
			aliasRevoked =
				String(error.message).indexOf("no longer") !== -1;
		}

		sourceFormsRevoked = assignmentRevoked && aliasRevoked;

		lowerUnchangedAtTransition =
			JSON.stringify(effects.capture(
				wiki.getTiddler(childTitle)
			)) === JSON.stringify(childBefore);

		// The source writer must still work after local resignation.
		operational.get("charter").setStatus({
			phase: "resigned"
		});
	}

	function child(event, operational) {
		if (event.type === "ready") {
			oldChildMission = operational.get("mission");

			assert(
				oldChildMission.task().name === "worker",
				"Initial child assignment is unreadable"
			);

			childReady = true;
			return;
		}

		if (
			event.type !== "document-change" ||
			event.key !== "mission"
		) {
			return;
		}

		var assignment = operational.get("mission");
		var view = assignment.inspect();

		if (view.active) {
			return;
		}

		childObservedInactive = !view.readable;

		assert(
			operational.keys().indexOf("alias") !== -1 &&
				operational.keys().indexOf("deeper") !== -1,
			"Revocation physically removed lower documents"
		);

		assert(
			!operational.get("alias").inspect().active,
			"Assignment alias retained authority"
		);
		assert(
			!operational.get("deeper").inspect().active,
			"Descendant retained authority"
		);

		assertThrows(function () {
			assignment.task();
		});

		assertThrows(function () {
			assignment.createPart("forbidden", {});
		});

		try {
			oldChildMission.inspect();
		} catch (error) {
			previousContextClosed =
				String(error.message).indexOf("closed") !== -1;
		}

		// Loss of assignment authority does not revoke registry custody.
		operational.get("charter").setStatus({
			phase: "inactive"
		});

		childNotified = true;
	}

	function addJob(title, executor, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(Object.assign({
				charter: {
					form: "charter",
					status: { phase: "initial" }
				}
			}, registry))
		}));
	}

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: { name: "root" },
			parts: {
				worker: {
					task: { name: "worker" },
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

	addJob(parentTitle, "linked-lifecycle-parent", {
		mission: mission([]),
		alias: mission([]),
		subordinate: childTitle,
		note: { form: "memo", data: "parent evidence" }
	});

	addJob(childTitle, "linked-lifecycle-child", {
		mission: mission(["worker"]),
		alias: mission(["worker"]),
		deeper: mission(["worker", "item"]),
		unrelated: unrelatedMission,
		note: { form: "memo", data: "child evidence" }
	});

	childBefore = effects.capture(wiki.getTiddler(childTitle));
	var childRegistryBefore = JSON.parse(childBefore.text);
	var projectBefore = effects.capture(wiki.getTiddler(project));

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	var dispatcher = new Dispatcher({
		runtime: runtime,
		Tiddler: tw.Tiddler,
		modules: moduleSource([
			{
				name: "linked-lifecycle-parent",
				browser: parent,
				node: parent
			},
			{
				name: "linked-lifecycle-child",
				browser: child,
				node: child
			}
		])
	});

	runtime.start();

	try {
		dispatcher.start();

		await waitFor(function () {
			return childNotified || (
				dispatcher.inspect().errors.some(function (error) {
					return error.title === childTitle;
				})
			);
		}, 2000);

		assert(childNotified, "Child failed to process authority loss");
		assert(tickCount === 1, "Unexpected transition count");
		assert(lowerUnchangedAtTransition, "Transition wrote the lower tiddler");
		assert(childObservedInactive, "Notification did not expose authority loss");
		assert(previousContextClosed, "Notification reused an old context");

		var parentTiddler = wiki.getTiddler(parentTitle);
		var parentRegistry = JSON.parse(parentTiddler.fields.text);
		var childTiddler = wiki.getTiddler(childTitle);
		var childRegistry = JSON.parse(childTiddler.fields.text);

		assert(
			!parentRegistry.mission && !parentRegistry.alias,
			"Source retained removed assignment aliases"
		);
		assert(
			parentRegistry.subordinate === childTitle,
			"Transition removed the hierarchy edge"
		);
		assert(
			parentRegistry.note.data === "parent evidence",
			"Transition removed the source memo"
		);

		Object.keys(childRegistryBefore).forEach(function (key) {
			if (key !== "charter") {
				assert(
					JSON.stringify(childRegistry[key]) ===
						JSON.stringify(childRegistryBefore[key]),
					"Lower document changed: " + key
				);
			}
		});

		assert(
			JSON.stringify(childRegistry.charter.book) ===
				JSON.stringify(childRegistryBefore.charter.book),
			"Child charter instruction changed"
		);
		assert(
			childRegistry.charter.status.phase === "inactive",
			"Child could not update its status"
		);
		assert(
			childTiddler.fields["clerus-custody"] === platform,
			"Authority loss revoked child custody"
		);
		assert(
			JSON.stringify(effects.capture(wiki.getTiddler(project))) ===
				JSON.stringify(projectBefore),
			"Transition changed the project"
		);

		var jobs = runtime.inspect().jobs;

		assert(
			missions.read(
				wiki,
				jobs,
				childTitle,
				childRegistry.unrelated
			).active,
			"Unrelated assignment lost authority"
		);

		var errors = dispatcher.inspect().errors;

		if (fail) {
			assert(dismissed, "Missing dismissal event");
			assert(dismissalWriteRefused, "Dismissed executor could write");
			assert(
				dismissalKeys.length === 2 &&
					dismissalKeys.indexOf("mission") !== -1 &&
					dismissalKeys.indexOf("alias") !== -1,
				"Dismissal lost removed-key metadata"
			);
			assert(
				parentTiddler.fields["clerus-custody"] === "user",
				"Failed source was not handed to the user"
			);
			assert(
				parentRegistry.charter.status.phase === "dismissed",
				"Dismissal status missing"
			);
			assert(
				errors.length === 1 &&
					errors[0].title === parentTitle &&
					errors[0].message === "Deliberate linked director failure" &&
					!errors[0].transitionError,
				"Wrong dismissal diagnostic"
			);
		} else {
			assert(sourceFormsRevoked, "Removed source forms remained usable");
			assert(!dismissed, "Voluntary resignation dismissed the source");
			assert(
				parentTiddler.fields["clerus-custody"] === platform,
				"Voluntary resignation revoked custody"
			);
			assert(
				parentRegistry.charter.status.phase === "resigned",
				"Source writer failed after resignation"
			);
			assert(errors.length === 0, "Unexpected resignation errors");
		}

		assert(runtime.inspect().missions.valid, "Final mission audit failed");
		assert(runtime.inspect().hierarchy.valid, "Final hierarchy audit failed");
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testFlowInterruptedMaterialization(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/interrupted-flow-owner";
	var target = "Interrupted Flow Target";

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: "initial"
			}
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		text: "Initial"
	}));

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	// Apply the external effect before the owner effect.
	plan.patch(target, { text: "Committed" });
	plan.patch(owner, {
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: "committed"
			}
		})
	});

	var compiled = plan.export();
	var flow = new FlowWal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () {
			return "interrupted-materialization";
		}
	});

	var title = flow.register({
		title: owner,
		executor: "test",
		persistent: true
	}, plan.initial(owner), compiled);

	var originalAdd = wiki.addTiddler.bind(wiki);
	var injected = false;

	wiki.addTiddler = function (tiddler) {
		var result = originalAdd(tiddler);

		if (
			tiddler.fields.title === target &&
			!injected
		) {
			injected = true;
			throw new Error("Injected flow interruption");
		}

		return result;
	};

	try {
		assertThrows(function () {
			flow.resume(title);
		}, "Injected flow interruption");

		assert(injected, "Failure injection did not run");

		var journal = wiki.getTiddler(title);
		var record = JSON.parse(journal.fields.text);

		assert(
			journal.fields["clerus-custody"] === "user",
			"Interrupted journal was not paused"
		);
		assert(record.active, "Accepted plan was discarded");
		assert(
			JSON.stringify(record.active.plan) === JSON.stringify(compiled),
			"Accepted plan changed after interruption"
		);
		assert(
			record.errors.length === 0,
			"Interruption became a completed branch failure"
		);
		assert(
			wiki.getTiddler(target).fields.text === "Committed",
			"First effect was not applied"
		);
		assert(
			JSON.parse(wiki.getTiddler(owner).fields.text)
				.charter.status === "initial",
			"Materialization continued after interruption"
		);
	} finally {
		wiki.addTiddler = originalAdd;
		plan.abort();
	}

	// Restore from materialized tiddlers only.
	var restarted = new tw.Wiki();

	wiki.each(function (tiddler) {
		restarted.addTiddler(
			new tw.Tiddler(effects.capture(tiddler))
		);
	});

	var recoveredFlow = new FlowWal({
		wiki: restarted,
		Tiddler: tw.Tiddler,
		platform: platform
	});

	assert(
		recoveredFlow.recover()[0].status === "paused",
		"Paused materialization retried automatically"
	);

	// Explicitly authorize retry.
	restarted.addTiddler(new tw.Tiddler(
		restarted.getTiddler(title),
		{ "clerus-custody": platform }
	));

	var recovery = recoveredFlow.recover();

	assert(
		recovery[0].status === "closed",
		"Accepted plan did not recover"
	);
	assert(
		!restarted.tiddlerExists(title),
		"Completed journal remained"
	);
	assert(
		restarted.getTiddler(target).fields.text === "Committed",
		"Recovery lost the external effect"
	);
	assert(
		JSON.parse(restarted.getTiddler(owner).fields.text)
			.charter.status === "committed",
		"Recovery did not finish the owner effect"
	);
}

function testCommitFailurePreservesOwner(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/commit-barrier-owner";
	var target = "Commit Barrier Target";
	var readyCount = 0;
	var suspendedCount = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		text: "Initial"
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "commit-barrier-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			document: target,
			permission: {
				form: "warrant",
				filter: "[title[Commit Barrier Target]]",
				operations: ["patch"],
				fields: ["text"]
			}
		})
	}));

	var ownerBefore = effects.capture(wiki.getTiddler(owner));

	function react(event, operational) {
		if (event.type === "suspended") {
			suspendedCount++;
			return;
		}

		if (event.type !== "ready") {
			return;
		}

		readyCount++;

		if (operational.get("charter").status().phase !== "initial") {
			return;
		}

		operational.get("document").patch("permission", {
			set: { text: "Committed" }
		});

		operational.get("charter").setStatus({
			phase: "committed"
		});
	}

	function createDispatcher(runtime) {
		return new Dispatcher({
			runtime: runtime,
			Wiki: tw.Wiki,
			Tiddler: tw.Tiddler,
			modules: moduleSource([{
				name: "commit-barrier-test",
				browser: react,
				node: react
			}])
		});
	}

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});
	var dispatcher = createDispatcher(runtime);
	var originalAdd = wiki.addTiddler.bind(wiki);
	var injected = false;

	wiki.addTiddler = function (tiddler) {
		var result = originalAdd(tiddler);

		if (
			tiddler.fields.title === target &&
			tiddler.fields.text === "Committed" &&
			!injected
		) {
			injected = true;
			throw new Error("Injected commit interruption");
		}

		return result;
	};

	runtime.start();

	var journalTitle;

	try {
		dispatcher.start();

		assert(injected, "Commit interruption was not injected");
		assert(readyCount === 1, "Wrong initial reaction count");
		assert(suspendedCount === 0, "Infrastructure failure suspended owner");

		assert(
			JSON.stringify(effects.capture(wiki.getTiddler(owner))) ===
				JSON.stringify(ownerBefore),
			"Failure handling rewrote the owner"
		);

		wiki.each(function (tiddler, title) {
			if (title.indexOf(dispatcher.wal.prefix) === 0) {
				journalTitle = title;
			}
		});

		assert(journalTitle, "Accepted plan WAL was lost");
		assert(
			dispatcher.materializationBlockers({
				title: owner,
				persistent: true
			}).length === 1,
			"Unfinished plan did not block owner"
		);

		dispatcher.scan();

		assert(readyCount === 1, "Blocked owner was reactivated");
		assert(
			dispatcher.inspect().errors[0].phase === "commit",
			"Commit failure was misclassified"
		);
	} finally {
		wiki.addTiddler = originalAdd;
		dispatcher.stop();
		runtime.stop();
	}

	// A paused WAL must keep blocking execution after restart.
	runtime = new Runtime({ wiki: wiki, platform: platform });
	dispatcher = createDispatcher(runtime);
	runtime.start();

	try {
		dispatcher.start();
		assert(readyCount === 1, "Restart activated a blocked owner");
	} finally {
		dispatcher.stop();
		runtime.stop();
	}

	// Explicitly authorize recovery, then boot normally.
	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(journalTitle),
		{ "clerus-custody": platform }
	));

	runtime = new Runtime({ wiki: wiki, platform: platform });
	dispatcher = createDispatcher(runtime);
	runtime.start();

	try {
		dispatcher.start();

		assert(!wiki.tiddlerExists(journalTitle), "Recovery left the WAL");
		assert(readyCount === 2, "Recovered owner was not activated");
		assert(suspendedCount === 0, "Recovery suspended owner");

		assert(
			JSON.parse(wiki.getTiddler(owner).fields.text)
				.charter.status.phase === "committed",
			"Recovery did not finish the accepted plan"
		);
		assert(
			wiki.getTiddler(target).fields.text === "Committed",
			"Recovery lost the external effect"
		);
		assert(
			dispatcher.inspect().errors.length === 0,
			"Successful recovery produced executor errors"
		);
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

async function testAgentCall(tw, fail) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/agent-call-test";
	var transportCount = 0;
	var tickCount = 0;
	var requestWasDeferred = false;
	var transportSawRunning = false;
	var responseWasPersisted = false;

	function readRegistry() {
		return JSON.parse(wiki.getTiddler(title).fields.text);
	}

	function react(event, operational) {
		if (event.type === "ready") {
			if (operational.get("call").inspect().phase !== "idle") {
				return;
			}

			operational.get("call").submit({
				prompt: "Return forty-two"
			});

			requestWasDeferred =
				transportCount === 0 &&
				readRegistry().call.phase === "idle";

			if (fail) {
				throw new Error("Deliberate failure after submit");
			}

			return;
		}

		if (event.type !== "tick") {
			return;
		}

		tickCount++;

		var call = operational.get("call").inspect();

		responseWasPersisted =
			readRegistry().call.phase === "completed" &&
			readRegistry().call.response.answer === 42;

		operational.get("charter").setStatus({
			phase: "complete",
			answer: call.response.answer
		});
	}

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "agent-call-test",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			call: {
				form: "agent-call",
				id: "test-agent-session",
				sequence: "0",
				phase: "idle"
			}
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([{
			name: "agent-call-test",
			browser: react,
			node: react
		}]),
		agentTransport: function (request, metadata) {
			transportCount++;

			transportSawRunning =
				readRegistry().call.phase === "running" &&
				readRegistry().call.operation === metadata.id;

			assert(
				request.prompt === "Return forty-two",
				"Transport received the wrong request"
			);

			return Promise.resolve({ answer: 42 });
		}
	});

	runtime.start();

	try {
		dispatcher.start();

		if (fail) {
			// Let any accidentally scheduled transport microtask run.
			await new Promise(function (resolve) {
				setTimeout(resolve, 20);
			});

			assert(transportCount === 0, "Aborted submit called transport");
			assert(tickCount === 0, "Aborted submit emitted a tick");
			assert(readRegistry().call.phase === "idle", "Submit escaped abort");
			assert(
				readRegistry().charter.status.phase === "suspended",
				"Failed executor was not suspended"
			);
		} else {
			await waitFor(function () {
				return readRegistry().charter.status.phase === "complete";
			}, 2000);

			assert(transportCount === 1, "Wrong transport call count");
			assert(tickCount === 1, "Wrong completion tick count");
			assert(transportSawRunning, "Transport started before running commit");
			assert(responseWasPersisted, "Executor saw an unpersisted response");
			assert(readRegistry().charter.status.answer === 42, "Result was lost");
			assert(
				dispatcher.inspect().errors.length === 0,
				"Unexpected executor errors"
			);
		}

		assert(requestWasDeferred, "Submit caused an immediate external effect");
		assert(
			dispatcher.inspect().agentErrors.length === 0,
			"Unexpected agent driver errors"
		);
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

async function testInterruptedAgentCall(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/interrupted-agent-call";
	var transportCount = 0;
	var tickCount = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "interrupted-agent-call",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: {}
			},
			call: {
				form: "agent-call",
				id: "interrupted-session",
				sequence: "1",
				operation: "interrupted-session-1",
				phase: "running",
				request: { prompt: "Possibly already sent" }
			}
		})
	}));

	function react(event, operational) {
		if (event.type !== "tick") {
			return;
		}

		tickCount++;

		operational.get("charter").setStatus({
			phase: operational.get("call").inspect().phase
		});
	}

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([{
			name: "interrupted-agent-call",
			browser: react,
			node: react
		}]),
		agentTransport: function () {
			transportCount++;
			return Promise.resolve({});
		}
	});

	runtime.start();

	try {
		dispatcher.start();

		await waitFor(function () {
			return tickCount === 1;
		}, 2000);

		var registry = JSON.parse(wiki.getTiddler(title).fields.text);

		assert(transportCount === 0, "Interrupted request was silently repeated");
		assert(registry.call.phase === "uncertain", "Unknown outcome was lost");
		assert(
			registry.charter.status.phase === "uncertain",
			"Executor did not observe the persisted uncertainty"
		);
		assert(
			dispatcher.inspect().agentErrors.length === 0,
			"Unexpected recovery errors"
		);
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function controlledPromise() {
	var resolve;
	var reject;

	var promise = new Promise(function (done, fail) {
		resolve = done;
		reject = fail;
	});

	return {
		promise: promise,
		resolve: resolve,
		reject: reject
	};
}

async function testAgentLateResponse(tw, mode) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/late-agent-response";
	var request = controlledPromise();
	var transportCount = 0;
	var tickCount = 0;

	function registry() {
		return JSON.parse(wiki.getTiddler(title).fields.text);
	}

	function react(event, operational) {
		if (
			event.type === "ready" &&
			operational.get("call").inspect().phase === "idle"
		) {
			operational.get("call").submit({ prompt: "Wait" });
		}

		if (event.type === "tick") {
			tickCount++;

			operational.get("charter").setStatus({
				phase: operational.get("call").inspect().phase
			});
		}
	}

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "late-agent-response",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			call: {
				form: "agent-call",
				id: "late-session",
				sequence: "0",
				phase: "idle"
			}
		})
	}));

	var runtime = new Runtime({ wiki: wiki, platform: platform });
	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([{
			name: "late-agent-response",
			browser: react,
			node: react
		}]),
		agentTransport: function () {
			transportCount++;
			return request.promise;
		}
	});

	runtime.start();

	try {
		dispatcher.start();

		await waitFor(function () {
			return transportCount === 1;
		}, 2000);

		assert(registry().call.phase === "running", "Request is not running");

		if (mode === "replacement") {
			var current = registry();

			current.call = {
				form: "agent-call",
				id: "replacement-session",
				sequence: "0",
				phase: "idle"
			};

			wiki.addTiddler(new tw.Tiddler(
				wiki.getTiddler(title),
				{ text: JSON.stringify(current) }
			));
		} else if (mode === "custody") {
			wiki.addTiddler(new tw.Tiddler(
				wiki.getTiddler(title),
				{ "clerus-custody": "user" }
			));
		} else {
			dispatcher.stop();
		}

		var before = JSON.stringify(effects.capture(wiki.getTiddler(title)));

		request.resolve({ answer: "Too late" });

		// Let the complete transport continuation chain finish.
		await new Promise(function (resolve) {
			setTimeout(resolve, 20);
		});

		assert(
			JSON.stringify(effects.capture(wiki.getTiddler(title))) === before,
			"Late response changed the owner"
		);
		assert(tickCount === 0, "Late response emitted a completion tick");
		assert(transportCount === 1, "Late response caused a retry");

		if (mode === "stopped") {
			dispatcher.start();

			await waitFor(function () {
				return tickCount === 1;
			}, 2000);

			assert(
				registry().call.phase === "uncertain",
				"Restart accepted the response from a stopped driver"
			);
			assert(transportCount === 1, "Restart repeated the transport");
		}

		assert(
			dispatcher.inspect().agentErrors.length === 0,
			"Late response produced driver errors"
		);
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

async function testAgentResponseRecovery(tw, timing) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/agent-response-recovery";
	var transportCount = 0;
	var tickCount = 0;
	var injected = false;
	var originalAdd = wiki.addTiddler.bind(wiki);

	function registry() {
		return JSON.parse(wiki.getTiddler(title).fields.text);
	}

	function react(event, operational) {
		if (
			event.type === "ready" &&
			operational.get("call").inspect().phase === "idle"
		) {
			operational.get("call").submit({ prompt: "Answer" });
			return;
		}

		if (event.type === "tick") {
			tickCount++;

			var call = operational.get("call").inspect();

			assert(call.phase === "completed", "Tick preceded response commit");
			assert(call.response.answer === 42, "Recovered response was lost");

			operational.get("charter").setStatus({
				phase: "complete",
				answer: call.response.answer
			});
		}
	}

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "agent-response-recovery",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			call: {
				form: "agent-call",
				id: "response-recovery",
				sequence: "0",
				phase: "idle"
			}
		})
	}));

	var runtime = new Runtime({ wiki: wiki, platform: platform });

	function createDispatcher() {
		return new Dispatcher({
			runtime: runtime,
			Wiki: tw.Wiki,
			Tiddler: tw.Tiddler,
			modules: moduleSource([{
				name: "agent-response-recovery",
				browser: react,
				node: react
			}]),
			agentTransport: function () {
				transportCount++;
				return Promise.resolve({ answer: 42 });
			}
		});
	}

	var dispatcher = createDispatcher();

	wiki.addTiddler = function (tiddler) {
		var interrupt = false;

		if (tiddler.fields.title === title && !injected) {
			var next = JSON.parse(tiddler.fields.text);

			interrupt = next.call.phase === "completed";
		}

		if (interrupt) {
			injected = true;

			if (timing === "before") {
				throw new Error("Injected response commit interruption");
			}
		}

		var result = originalAdd(tiddler);

		if (interrupt && timing === "after") {
			throw new Error("Injected response commit interruption");
		}

		return result;
	};

	runtime.start();

	var journalTitle;

	try {
		dispatcher.start();

		await waitFor(function () {
			return injected &&
				dispatcher.inspect().agentErrors.length > 0;
		}, 2000);

		assert(transportCount === 1, "Wrong initial transport count");
		assert(tickCount === 0, "Interrupted response emitted a tick");
		assert(
			wiki.getTiddler(title).fields["clerus-custody"] === platform,
			"Infrastructure failure changed owner custody"
		);

		var blockers = dispatcher.materializationBlockers({
			title: title,
			persistent: true
		});

		assert(blockers.length === 1, "Response plan did not block the owner");
		journalTitle = blockers[0];

		var record = JSON.parse(wiki.getTiddler(journalTitle).fields.text);

		assert(record.active, "Accepted response plan was discarded");
		assert(
			record.active.plan.deferred.length === 1,
			"Accepted plan lost its notification"
		);

		assert(
			registry().call.phase ===
				(timing === "before" ? "running" : "completed"),
			"Unexpected state at interruption"
		);

		dispatcher.scan();

		assert(tickCount === 0, "Blocked response was delivered");
		assert(transportCount === 1, "Blocked request was repeated");
	} finally {
		wiki.addTiddler = originalAdd;
		dispatcher.stop();
		runtime.stop();
	}

	// Reconstruct materialized state, without keeping driver closures.
	var restarted = new tw.Wiki();

	wiki.each(function (tiddler) {
		restarted.addTiddler(new tw.Tiddler(effects.capture(tiddler)));
	});

	wiki = restarted;
	runtime = new Runtime({ wiki: wiki, platform: platform });

	// Authorize continuation of the accepted response plan.
	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(journalTitle),
		{ "clerus-custody": platform }
	));

	dispatcher = createDispatcher();
	runtime.start();

	try {
		dispatcher.start();

		await waitFor(function () {
			return registry().charter.status.phase === "complete";
		}, 2000);

		assert(transportCount === 1, "Recovery repeated the external request");
		assert(tickCount === 1, "Recovery duplicated or lost notification");
		assert(registry().call.response.answer === 42, "Response changed");
		assert(!wiki.tiddlerExists(journalTitle), "Response WAL remained");

		assert(
			dispatcher.inspect().errors.length === 0 &&
				dispatcher.inspect().agentErrors.length === 0,
			"Recovery produced errors"
		);
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

async function testOpenRouterTransport() {
	var calls = [];
	var mode = "success";
	var secret = "test-secret-do-not-persist";

	function FakeAbortController() {
		this.signal = {};
	}

	FakeAbortController.prototype.abort = function () {};

	var transport = openRouterTransport.createTransport({
		AbortController: FakeAbortController,
		getApiKey: function () {
			return secret;
		},
		fetch: function (url, options) {
			calls.push({
				url: url,
				options: options
			});

			if (mode === "network") {
				return Promise.reject(new Error(secret));
			}

			if (mode === "http") {
				return Promise.resolve({
					ok: false,
					status: 503
				});
			}

			return Promise.resolve({
				ok: true,
				status: 200,
				json: function () {
					if (mode === "invalid-json") {
						return Promise.reject(new Error(secret));
					}

					return Promise.resolve({
						id: "completion-test",
						model: "test/model",
						choices: [{
							message: {
								role: "assistant",
								content: "Forty-two"
							},
							finish_reason: "stop"
						}],
						usage: {
							total_tokens: 12
						}
					});
				}
			});
		}
	});

	function request() {
		return {
			model: "test/model",
			messages: [{
				role: "user",
				content: "Answer"
			}],
			max_tokens: 32
		};
	}

	async function rejected(input) {
		try {
			await transport(input);
		} catch (error) {
			return error;
		}

		throw new Error("Expected transport rejection");
	}

	var response = await transport(request());

	assert(calls.length === 1, "Wrong HTTP call count");
	assert(
		calls[0].url ===
			"https://openrouter.ai/api/v1/chat/completions",
		"Wrong endpoint"
	);
	assert(calls[0].options.method === "POST", "Wrong HTTP method");
	assert(calls[0].options.redirect === "error", "Redirects were allowed");
	assert(
		calls[0].options.headers.Authorization === "Bearer " + secret,
		"Missing authorization"
	);
	assert(
		JSON.parse(calls[0].options.body).stream === false,
		"Streaming was not disabled"
	);
	assert(response.usage.total_tokens === 12, "Usage metadata was lost");
	assert(response.id === "completion-test", "Response identity was lost");

	var invalid = request();
	invalid.stream = true;

	var before = calls.length;
	var error = await rejected(invalid);

	assert(error.definitelyNotExecuted === true, "Local error is ambiguous");
	assert(calls.length === before, "Invalid request reached fetch");

	for (var i = 0; i < 3; i++) {
		mode = ["network", "http", "invalid-json"][i];
		before = calls.length;
		error = await rejected(request());

		assert(calls.length === before + 1, "Transport retried a request");
		assert(
			error.definitelyNotExecuted !== true,
			"External failure was declared definitely unexecuted"
		);
		assert(
			String(error.message).indexOf(secret) === -1,
			"Error disclosed the API key"
		);
	}
}

function testAgentSessionContext() {
	var registry = {
		session: {
			form: "agent-session",
			id: "session-test",
			call: {
				key: "call",
				id: "session-call"
			},
			parameters: {
				model: "test/model",
				max_tokens: 128
			},
			messages: [],
			phase: "ready"
		},
		call: {
			form: "agent-call",
			id: "session-call",
			sequence: "0",
			phase: "idle"
		}
	};

	var commits = 0;
	var refuseCommit = false;
	var forms = contexts.loadForms(moduleSource([]));

	function clone(value) {
		return JSON.parse(JSON.stringify(value));
	}

	function open() {
		function replace() {
			throw new Error("Expected an atomic registry update");
		}

		replace.replaceAll = function (next) {
			if (refuseCommit) {
				throw new Error("Injected registry refusal");
			}

			registry = clone(next);
			commits++;
		};

		return contexts.openContext(registry, forms, {
			replace: replace,
			atomicRegistryUpdates: true
		});
	}

	var scope = open();

	try {
		var session = scope.context.get("session");
		var call = scope.context.get("call");

		refuseCommit = true;

		assertThrows(function () {
			session.send("First");
		}, "Injected");

		assert(session.inspect().messages.length === 0, "Local history leaked");
		assert(call.inspect().phase === "idle", "Local call leaked");
		assert(registry.session.messages.length === 0, "Stored history leaked");
		assert(commits === 0, "Refused update committed");

		refuseCommit = false;
		session.send("First");

		assert(commits === 1, "Send was not one atomic update");
		assert(call.inspect().phase === "queued", "Existing call form is stale");
		assert(
			call.inspect().request.messages[0].content === "First",
			"Wrong first request"
		);

		assertThrows(function () {
			session.send("Premature");
		}, "not ready");
	} finally {
		scope.close();
	}

	// Simulate a separately persisted driver response and a fresh context.
	registry.call.phase = "completed";
	registry.call.response = {
		choices: [{
			message: {
				role: "assistant",
				content: "First answer"
			}
		}]
	};

	scope = open();

	try {
		var session = scope.context.get("session");

		assert(session.receive(), "Response was not accepted");
		assert(!session.receive(), "Response was accepted twice");
		assert(session.inspect().messages.length === 2, "Wrong history length");

		var view = session.inspect();
		view.messages[0].content = "Local mutation";

		assert(
			session.inspect().messages[0].content === "First",
			"Inspection leaked mutable history"
		);

		session.send("Second");

		var request = scope.context.get("call").inspect().request;

		assert(request.messages.length === 3, "History was not included");
		assert(
			request.messages[1].content === "First answer" &&
			request.messages[2].content === "Second",
			"Wrong second request history"
		);
	} finally {
		scope.close();
	}

	// Replacing the linked document must not silently rebind the session.
	registry.call.id = "replacement";
	registry.call.operation = "replacement-" + registry.call.sequence;

	scope = open();

	try {
		var before = JSON.stringify(registry);

		assertThrows(function () {
			scope.context.get("session").receive();
		}, "identity has changed");

		assert(
			JSON.stringify(registry) === before,
			"Rejected receipt changed the registry"
		);
	} finally {
		scope.close();
	}
}

function testAgentWikiToolPlanning(tw, fail) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/wiki-tool-planning";
	var target = "Agent Tool Target";
	var observedDeferred = false;

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		text: "Original"
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "wiki-tool-planning",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			document: target,
			permission: {
				form: "warrant",
				filter: "[title[Agent Tool Target]]",
				operations: ["patch"],
				fields: ["text"]
			}
		})
	}));

	function invocation(id, name, args) {
		return {
			id: id,
			type: "function",
			function: {
				name: name,
				arguments: JSON.stringify(args)
			}
		};
	}

	function react(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var results = agentWikiTools.execute([
			invocation("read", "read_document", {}),
			invocation("write", "replace_document_text", {
				expected_text: "Original",
				text: "Updated"
			}),
			invocation("stale", "replace_document_text", {
				expected_text: "Original",
				text: "Must not overwrite"
			}),
			invocation("read-again", "read_document", {})
		], operational, {
			documentKey: "document",
			warrantKey: "permission"
		}).map(function (item) {
			return JSON.parse(item.content);
		});

		assert(results[0].text === "Original", "Wrong initial tool read");
		assert(results[1].ok, "Tool write was refused");
		assert(
			results[2].error === "text-conflict",
			"Stale tool write was accepted"
		);
		assert(
			results[3].text === "Updated",
			"Tool did not read its planned write"
		);

		observedDeferred =
			wiki.getTiddler(target).fields.text === "Original";

		operational.get("charter").setStatus({
			phase: "complete",
			results: results
		});

		if (fail) {
			throw new Error("Deliberate failure after tool execution");
		}
	}

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	var dispatcher = new Dispatcher({
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		modules: moduleSource([{
			name: "wiki-tool-planning",
			browser: react,
			node: react
		}])
	});

	runtime.start();

	try {
		dispatcher.start();

		assert(observedDeferred, "Tool write escaped planning");
		assert(
			wiki.getTiddler(target).fields.text ===
				(fail ? "Original" : "Updated"),
			"Wrong target state after reaction"
		);

		var registry = JSON.parse(wiki.getTiddler(owner).fields.text);

		assert(
			registry.charter.status.phase ===
				(fail ? "suspended" : "complete"),
			"Wrong owner state"
		);

		assert(
			dispatcher.inspect().errors.length === (fail ? 1 : 0),
			"Unexpected executor errors"
		);
	} finally {
		dispatcher.stop();
		runtime.stop();
	}
}

function testWarrantMissionScope(tw) {
	var fixture = linkedMissionFixture();
	var platform = tw.browser ? "browser" : "node";
	var wiki = new tw.Wiki();
	var jobs = fixture.jobs;
	var worker = jobs[1];

	function clone(value) {
		return JSON.parse(JSON.stringify(value));
	}

	jobs.forEach(function (job) {
		job.valid = true;
		job.local = true;
		job.owned = true;
		job.custody = platform;
		job.executor = "scope-test";

		wiki.addTiddler(new tw.Tiddler({
			title: job.title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": job.executor,
			text: JSON.stringify(job.registry)
		}));
	});

	var runtime = {
		wiki: wiki,
		platform: platform,
		inspect: function () {
			return { jobs: clone(jobs) };
		}
	};

	var warrant = {
		form: "warrant",
		filter: "[all[tiddlers]]",
		operations: ["patch"],
		fields: ["text"],
		mission: {
			project: fixture.project,
			role: ["department"],
			link: "11"
		}
	};

	function authorize(state, permission, source) {
		warrantMission.authorize({
			runtime: runtime,
			state: state,
			job: source || worker,
			warrant: permission || warrant
		});
	}

	var live = operationStates.live(wiki, tw.Tiddler);

	authorize(live);

	// The same assignment held by another job is insufficient.
	assertThrows(function () {
		authorize(live, warrant, jobs[2]);
	}, "locally held");

	// Aliases do not invalidate a legal grant.
	worker.registry.alias = clone(worker.registry.mission);

	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(worker.title),
		{ text: JSON.stringify(worker.registry) }
	));

	authorize(live);

	// A changed upper binding revokes authority without lower writes.
	jobs[0].registry.mission.children.department = "13";

	assertThrows(function () {
		authorize(live);
	}, "active mission");

	jobs[0].registry.mission.children.department = "11";

	// A newer generation on the same role does not match the old warrant.
	var original = clone(worker.registry);

	worker.registry.mission.link = "13";
	worker.registry.alias.link = "13";
	jobs[0].registry.mission.children.department = "13";

	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(worker.title),
		{ text: JSON.stringify(worker.registry) }
	));

	assertThrows(function () {
		authorize(live);
	}, "locally held");

	worker.registry = original;
	jobs[0].registry.mission.children.department = "11";

	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(worker.title),
		{ text: JSON.stringify(worker.registry) }
	));

	// Planned removal must be visible even while the real job still
	// owns the assignment.
	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	try {
		var registry = clone(worker.registry);

		delete registry.mission;
		delete registry.alias;

		plan.patch(worker.title, {
			text: JSON.stringify(registry)
		});

		assertThrows(function () {
			authorize(operationStates.planned(plan));
		}, "locally held");

		authorize(live);

		// Legacy warrants remain unrestricted by assignment state.
		var legacy = clone(warrant);
		delete legacy.mission;

		authorize(operationStates.planned(plan), legacy);
	} finally {
		plan.abort();
	}

	var malformed = clone(warrant);
	malformed.mission.link = null;

	assertThrows(function () {
		warrantMission.validate(malformed);
	}, "Invalid warrant mission");
}


function deferredEventsRetainTheirRecipients(tw) {
	var fixture = delegationFixture(tw);
	var platform = tw.browser ? "browser" : "node";

	delete fixture.director.registry.mission.children.department;
	delete fixture.manager.registry.subordinate;

	var flow = new FlowWal({
		wiki: fixture.wiki,
		Tiddler: tw.Tiddler,
		platform: platform
	});

	var effect = deferredEffects.create({
		id: "retention-tick",
		recipient: {
			title: fixture.worker.title,
			executor: "spec-retention",
			platform: platform
		}
	});

	var title = deferredWal.record(flow, effect);

	// Pausing execution must not erase the retention obligation.
	fixture.wiki.addTiddler(new tw.Tiddler(
		fixture.wiki.getTiddler(title),
		{ "clerus-custody": "user" }
	));

	var before = JSON.stringify(
		effects.capture(fixture.wiki.getTiddler(title))
	);
	var report = jobRetention.evaluate(fixture.wiki, fixture.jobs);
	var retained = report.retained.find(function (entry) {
		return entry.title === fixture.worker.title;
	});

	assert(
		report.complete &&
			retained &&
			retained.reasons.some(function (reason) {
				return reason.kind === "deferred-event";
			}),
		"A paused deferred event did not retain its recipient"
	);

	assert(
		JSON.stringify(
			effects.capture(fixture.wiki.getTiddler(title))
		) === before,
		"Retention analysis changed the deferred obligation"
	);

	fixture.wiki.deleteTiddler(title);

	report = jobRetention.evaluate(fixture.wiki, fixture.jobs);

	assert(
		report.complete &&
			report.candidates.indexOf(fixture.worker.title) !== -1,
		"Removing the deferred obligation left persisted retention"
	);
}


function acceptedAppointmentsRetainRecipientsAndStaff(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/spec-retention-appointment";
	var recipient = owner + "/replacement";
	var staff = "$:/clerus/jobs/spec-retention-appointment-staff";

	[owner, staff].forEach(function (title) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "spec-retention",
			text: JSON.stringify({
				charter: { form: "charter", status: {} }
			})
		}));
	});

	var effect = appointmentEffects.create({
		id: "retention-appointment",
		source: {
			title: owner,
			executor: "spec-retention",
			platform: platform
		},
		recipient: {
			title: recipient,
			executor: "spec-retention",
			platform: platform
		},
		contract: {
			form: "contract",
			temp: false,
			executor: "spec-retention"
		},
		titles: { staff: staff }
	}, documentFlow.loadRules(specificationModules({})));

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	plan.appoint(effect);

	var flow = new FlowWal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () {
			return "retention-appointment";
		}
	});

	var title;

	try {
		title = flow.register({
			title: owner,
			executor: "spec-retention",
			persistent: true
		}, plan.initial(owner), plan.export());
	} finally {
		plan.abort();
	}

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	function inspect() {
		return jobRetention.evaluate(wiki, runtime.inspect().jobs);
	}

	var report = inspect();

	function hasReason(jobTitle, kind) {
		return report.retained.some(function (entry) {
			return entry.title === jobTitle &&
				entry.reasons.some(function (reason) {
					return reason.kind === kind;
				});
		});
	}

	assert(
		report.complete &&
			hasReason(owner, "accepted-plan-owner") &&
			hasReason(staff, "appointment-reference") &&
			!wiki.getTiddler(recipient),
		"An unmaterialized appointment lost its staff references: " +
			JSON.stringify(report)
	);

	// Stop at a real partial-materialization boundary: the child exists,
	// but the accepted flow has not yet recorded completion.
	appointmentEffects.materialize(wiki, tw.Tiddler, effect);

	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(title),
		{ "clerus-custody": "user" }
	));

	var childBefore = JSON.stringify(
		effects.capture(wiki.getTiddler(recipient))
	);
	var journalBefore = JSON.stringify(
		effects.capture(wiki.getTiddler(title))
	);

	report = inspect();

	assert(
		report.complete &&
			hasReason(recipient, "accepted-appointment") &&
			hasReason(staff, "appointment-reference"),
		"A paused appointment did not retain its materialized recipient: " +
			JSON.stringify(report)
	);

	assert(
		JSON.stringify(
			effects.capture(wiki.getTiddler(recipient))
		) === childBefore &&
			JSON.stringify(
				effects.capture(wiki.getTiddler(title))
			) === journalBefore,
		"Retention analysis changed partial appointment materialization"
	);
}


function runtimeReconstructsRetentionWithoutStoredBookkeeping(tw) {
	var fixture = delegationFixture(tw);
	var platform = tw.browser ? "browser" : "node";
	var wiki = fixture.wiki;

	fixture.jobs.forEach(function (job) {
		var registry = clone(job.registry);

		registry.charter = {
			form: "charter",
			status: {}
		};

		wiki.addTiddler(new tw.Tiddler({
			title: job.title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "spec-retention",
			text: JSON.stringify(registry)
		}));
	});

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	function captureWiki(currentWiki) {
		var records = [];

		currentWiki.each(function (tiddler, title) {
			records.push({
				title: title,
				fields: effects.capture(tiddler)
			});
		});

		records.sort(function (left, right) {
			return left.title < right.title
				? -1
				: left.title > right.title ? 1 : 0;
		});

		return records;
	}

	runtime.start();

	try {
		var initial = runtime.inspect();

		assert(
			initial.retention.complete &&
				initial.retention.retained.length === 3 &&
				initial.retention.candidates.length === 0,
			"Runtime did not expose the initial retention perspective"
		);

		// Neither mutating the returned perspective nor inspecting it
		// may change authoritative state.
		var before = captureWiki(wiki);

		initial.retention.retained.length = 0;
		initial.retention.candidates.push(fixture.director.title);

		assert(
			runtime.inspect().retention.retained.length === 3 &&
				sameJson(captureWiki(wiki), before),
			"Runtime exposed mutable or materialized retention state"
		);

		// Change authoritative facts without waiting for batched events.
		var director = JSON.parse(
			wiki.getTiddler(fixture.director.title).fields.text
		);
		var manager = JSON.parse(
			wiki.getTiddler(fixture.manager.title).fields.text
		);

		delete director.mission.children.department;
		delete manager.subordinate;

		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(fixture.director.title),
			{ text: JSON.stringify(director) }
		));

		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(fixture.manager.title),
			{ text: JSON.stringify(manager) }
		));

		var changed = runtime.inspect().retention;

		assert(
			changed.complete &&
				changed.candidates.indexOf(fixture.worker.title) !== -1,
			"Runtime retention depended on delivery of change events"
		);

		var factsBeforeInspection = captureWiki(wiki);

		runtime.inspect();

		assert(
			sameJson(captureWiki(wiki), factsBeforeInspection) &&
				!!wiki.getTiddler(fixture.worker.title),
			"Retention inspection changed or collected a job"
		);

		// Only materialized tiddlers cross the reconstruction boundary.
		var restored = restoredWiki(tw, wiki);
		var fresh = new Runtime({
			wiki: restored,
			platform: platform
		});

		fresh.start();

		try {
			assert(
				sameJson(fresh.inspect().retention, changed),
				"A fresh runtime required persisted retention bookkeeping"
			);
		} finally {
			fresh.stop();
		}
	} finally {
		runtime.stop();
	}
}


function collectionFixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/clerus/jobs/spec-collection";

	function add(name, registry, fields) {
		var title = prefix + "/" + name;

		wiki.addTiddler(new tw.Tiddler(Object.assign({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "spec-collection",
			text: JSON.stringify(Object.assign({
				charter: { form: "charter", status: {} }
			}, registry || {}))
		}, fields || {})));

		return title;
	}

	return {
		wiki: wiki,
		platform: platform,
		add: add,
		runtime: new Runtime({
			wiki: wiki,
			platform: platform
		})
	};
}


function collectionStopsAtIncompleteOrInvalidFacts(tw) {
	var fixture = collectionFixture(tw);
	var orphan = fixture.add("orphan");
	var journalTitle =
		"$:/clerus/wal/" + fixture.platform + "/collection-unreadable";

	fixture.wiki.addTiddler(new tw.Tiddler({
		title: journalTitle,
		type: "application/json",
		"clerus-custody": "user",
		text: "{"
	}));

	var incomplete = jobCollection.collect(fixture.runtime);

	assert(
		incomplete.removed.length === 0 &&
			incomplete.blocked.indexOf("incomplete-retention") !== -1 &&
			!!fixture.wiki.getTiddler(orphan),
		"Collection proceeded through unreadable obligations"
	);

	fixture.wiki.deleteTiddler(journalTitle);

	var left = fixture.add("left");
	var right = fixture.add("right", { subordinate: left });
	var leftRegistry = JSON.parse(
		fixture.wiki.getTiddler(left).fields.text
	);

	leftRegistry.subordinate = right;

	fixture.wiki.addTiddler(new tw.Tiddler(
		fixture.wiki.getTiddler(left),
		{ text: JSON.stringify(leftRegistry) }
	));

	var invalid = jobCollection.collect(fixture.runtime);

	assert(
		invalid.removed.length === 0 &&
			invalid.blocked.indexOf(
				"invalid-or-incomplete-hierarchy"
			) !== -1 &&
			!!fixture.wiki.getTiddler(orphan),
		"Collection attempted to repair an invalid organization by deletion"
	);
}


function collectionRechecksFactsBetweenDeletions(tw) {
	check("reference");
	check("unreadable-wal");

	function check(intervention) {
		var fixture = collectionFixture(tw);
		var first = fixture.add("a-first");
		var second = fixture.add("b-second");
		var keeper = fixture.add("keeper", {
			mission: {
				form: "mission",
				project: "Collection Intervention Project",
				role: [],
				link: "10",
				issued: "0",
				children: {}
			}
		});

		var originalDelete =
			fixture.wiki.deleteTiddler.bind(fixture.wiki);
		var intervened = false;
		var journalTitle =
			"$:/clerus/wal/" + fixture.platform +
			"/collection-intervention";

		fixture.wiki.deleteTiddler = function (title) {
			var result = originalDelete(title);

			if (title === first && !intervened) {
				intervened = true;

				if (intervention === "reference") {
					var registry = JSON.parse(
						fixture.wiki.getTiddler(keeper).fields.text
					);

					registry.subordinate = second;

					fixture.wiki.addTiddler(new tw.Tiddler(
						fixture.wiki.getTiddler(keeper),
						{ text: JSON.stringify(registry) }
					));
				} else {
					fixture.wiki.addTiddler(new tw.Tiddler({
						title: journalTitle,
						type: "application/json",
						"clerus-custody": "user",
						text: "{"
					}));
				}
			}

			return result;
		};

		var secondBefore = effects.capture(
			fixture.wiki.getTiddler(second)
		);
		var result;

		try {
			result = jobCollection.collect(fixture.runtime);
		} finally {
			fixture.wiki.deleteTiddler = originalDelete;
		}

		assert(
			intervened &&
				result.removed.length === 1 &&
				result.removed[0] === first,
			"The scenario did not intervene between candidate deletions: " +
				JSON.stringify(result)
		);

		assert(
			sameJson(
				effects.capture(fixture.wiki.getTiddler(second)),
				secondBefore
			),
			"Collection deleted or changed a job after " + intervention
		);

		if (intervention === "reference") {
			assert(
				result.blocked.length === 0 &&
					result.skipped.some(function (item) {
						return item.title === second &&
							item.reason === "retained";
					}),
				"Collection ignored a newly established reference: " +
					JSON.stringify(result)
			);
		} else {
			assert(
				result.blocked.indexOf("incomplete-retention") !== -1 &&
					!!fixture.wiki.getTiddler(journalTitle),
				"Collection continued after analysis became incomplete: " +
					JSON.stringify(result)
			);
		}
	}
}


async function dispatcherCollectionPreservesEphemeralWork(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title =
		"$:/temp/clerus/jobs/" + platform + "/spec-collection-deferred";
	var ticks = 0;
	var collectionInsideReaction;
	var environment;

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "spec-collection-deferred",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: {}
			}
		})
	}));

	function react(event, operational) {
		if (event.type === "ready") {
			collectionInsideReaction =
				environment.dispatcher.collectGarbage();

			operational.get("charter").defer();
			return;
		}

		if (event.type === "tick") {
			ticks++;
		}
	}

	environment = specificationEnvironment(tw, {
		wiki: wiki,
		platform: platform,
		executors: {
			"spec-collection-deferred": react
		}
	});

	try {
		environment.start();

		assert(
			collectionInsideReaction &&
				collectionInsideReaction.removed.length === 0 &&
				collectionInsideReaction.blocked.indexOf(
					"reaction-in-progress"
				) !== -1,
			"Collection ran inside an executor reaction"
		);

		assert(
			ticks === 0 &&
				environment.runtime.inspect().retention.candidates
					.indexOf(title) !== -1,
			"The scenario did not establish an ephemeral-only obligation"
		);

		var pending = environment.dispatcher.collectGarbage();

		assert(
			pending.removed.length === 0 &&
				pending.blocked.indexOf("ephemeral-ticks-pending") !== -1 &&
				!!wiki.getTiddler(title),
			"Collection discarded a job with a pending ephemeral tick: " +
				JSON.stringify(pending)
		);

		await waitFor(function () {
			var errors = environment.dispatcher.inspect().errors;

			assert(
				errors.length === 0,
				"Deferred collection scenario failed: " +
					JSON.stringify(errors)
			);

			return ticks === 1;
		}, 2000, "the ephemeral tick before collection");

		var completed = environment.dispatcher.collectGarbage();

		assert(
			completed.blocked.length === 0 &&
				completed.removed.length === 1 &&
				completed.removed[0] === title &&
				!wiki.getTiddler(title),
			"Completed ephemeral work left a stale collection barrier: " +
				JSON.stringify(completed)
		);
	} finally {
		environment.stop();
	}
}


function dispatcherCollectionPreservesQueuedEphemeralOrders(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform +
		"/spec-collection-orders/";
	var source = prefix + "a-source";
	var recipient = prefix + "b-recipient";
	var orders = 0;
	var checked = false;
	var collectionBeforeDelivery;

	function addJob(title, executor, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(Object.assign({
				charter: { form: "charter", status: {} }
			}, registry))
		}));
	}

	addJob(source, "spec-collection-order-source", {
		subordinate: recipient
	});
	addJob(recipient, "spec-collection-order-recipient", {});

	function sourceReact(event, operational) {
		if (event.type === "ready") {
			operational.get("subordinate").order({});
		}
	}

	function recipientReact(event) {
		if (event.type === "order") {
			orders++;
		}
	}

	var environment = specificationEnvironment(tw, {
		wiki: wiki,
		platform: platform,
		executors: {
			"spec-collection-order-source": sourceReact,
			"spec-collection-order-recipient": recipientReact
		}
	});

	var dispatcher = environment.dispatcher;
	var originalDeliver = dispatcher.deliverOrders;

	dispatcher.deliverOrders = function () {
		if (!checked && this.orders.length > 0) {
			checked = true;

			/*
			Intervene after legal enqueueing, before delivery.
			The queued order must now be protected independently
			of the preceding operational reference.
			*/
			var registry = JSON.parse(
				wiki.getTiddler(source).fields.text
			);

			delete registry.subordinate;

			wiki.addTiddler(new tw.Tiddler(
				wiki.getTiddler(source),
				{ text: JSON.stringify(registry) }
			));

			assert(
				environment.runtime.inspect().retention.candidates
					.indexOf(recipient) !== -1,
				"The scenario did not remove operational retention"
			);

			collectionBeforeDelivery = this.collectGarbage();

			assert(
				collectionBeforeDelivery.removed.length === 0 &&
					collectionBeforeDelivery.blocked.indexOf(
						"ephemeral-messages-pending"
					) !== -1 &&
					!!wiki.getTiddler(recipient),
				"Collection discarded a queued ephemeral order: " +
					JSON.stringify(collectionBeforeDelivery)
			);
		}

		return originalDeliver.apply(this, arguments);
	};

	try {
		environment.start();

		assert(
			checked &&
				orders === 1 &&
				dispatcher.inspect().errors.length === 0,
			"The synchronous pass did not deliver the protected order: " +
				JSON.stringify(dispatcher.inspect())
		);

		var completed = dispatcher.collectGarbage();

		assert(
			completed.blocked.length === 0 &&
				completed.removed.length === 2 &&
				completed.removed.indexOf(source) !== -1 &&
				completed.removed.indexOf(recipient) !== -1,
			"Completed delivery left a stale collection barrier: " +
				JSON.stringify(completed)
		);
	} finally {
		dispatcher.deliverOrders = originalDeliver;
		environment.stop();
	}
}


function automaticCollectionRunsAfterTheDispatchPass(tw) {
	var fixture = collectionFixture(tw);
	var orphan = fixture.add("orphan");
	var worker = fixture.add("worker");
	var root = fixture.add("root", {
		subordinate: worker,
		mission: {
			form: "mission",
			project: "Automatic Collection Project",
			role: [],
			link: "10",
			issued: "0",
			children: {}
		}
	});
	var activations = [];

	var environment = specificationEnvironment(tw, {
		wiki: fixture.wiki,
		platform: fixture.platform,
		autoCollectJobs: true,
		executors: {
			"spec-collection": function (event) {
				if (event.type === "ready") {
					activations.push(event.title);

					assert(
						!!fixture.wiki.getTiddler(orphan),
						"Automatic collection ran before activation completed"
					);
				}
			}
		}
	});

	try {
		environment.start();

		var inspection = environment.dispatcher.inspect();

		assert(
			inspection.errors.length === 0 &&
				activations.length === 3 &&
				activations.indexOf(orphan) !== -1,
			"Automatic collection changed ordinary activation: " +
				JSON.stringify(inspection)
		);

		assert(
			!fixture.wiki.getTiddler(orphan) &&
				!!fixture.wiki.getTiddler(root) &&
				!!fixture.wiki.getTiddler(worker),
			"Automatic collection did not preserve the retained organization"
		);

		assert(
			inspection.collection &&
				inspection.collection.blocked.length === 0 &&
				inspection.collection.removed.indexOf(orphan) !== -1,
			"Automatic collection did not expose its result: " +
				JSON.stringify(inspection)
		);

		// Inspection returns an isolated diagnostic value.
		inspection.collection.removed.length = 0;

		assert(
			environment.dispatcher.inspect().collection.removed
				.indexOf(orphan) !== -1,
			"Inspection exposed mutable collection diagnostics"
		);
	} finally {
		environment.stop();
	}
}


async function automaticCollectionWaitsForEphemeralTicks(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title =
		"$:/temp/clerus/jobs/" + platform + "/spec-auto-collection-tick";
	var readyCount = 0;
	var tickCount = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "spec-auto-collection-tick",
		text: JSON.stringify({
			charter: { form: "charter", status: {} }
		})
	}));

	var environment = specificationEnvironment(tw, {
		wiki: wiki,
		platform: platform,
		autoCollectJobs: true,
		executors: {
			"spec-auto-collection-tick": function (event, operational) {
				if (event.type === "ready") {
					readyCount++;
					operational.get("charter").defer();
				} else if (event.type === "tick") {
					tickCount++;

					assert(
						!!wiki.getTiddler(title),
						"Collection removed the job before its tick completed"
					);
				}
			}
		}
	});

	try {
		environment.start();

		var initial = environment.dispatcher.inspect();

		assert(
			readyCount === 1 &&
				tickCount === 0 &&
				!!wiki.getTiddler(title) &&
				initial.collection &&
				initial.collection.blocked.indexOf(
					"ephemeral-ticks-pending"
				) !== -1,
			"Automatic collection ignored the pending tick: " +
				JSON.stringify(initial)
		);

		await waitFor(function () {
			var inspection = environment.dispatcher.inspect();

			assert(
				inspection.errors.length === 0,
				"Automatic tick collection failed: " +
					JSON.stringify(inspection)
			);

			return !wiki.getTiddler(title);
		}, 2000, "automatic collection after the ephemeral tick");

		assert(
			readyCount === 1 && tickCount === 1,
			"Automatic collection interrupted or repeated ephemeral work"
		);
	} finally {
		environment.stop();
	}
}


function automaticCollectionPreservesInterruptedAcceptedWork(tw) {
	var fixture = collectionFixture(tw);
	var title = fixture.add("interrupted");
	var wiki = fixture.wiki;
	var readyCount = 0;
	var interrupted = false;
	var environment;

	function react(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		readyCount++;

		if (operational.get("charter").status().phase === "complete") {
			return;
		}

		operational.get("charter").setStatus({
			phase: "complete"
		});
	}

	function open() {
		return specificationEnvironment(tw, {
			wiki: wiki,
			platform: fixture.platform,
			autoCollectJobs: true,
			executors: {
				"spec-collection": react
			}
		});
	}

	var originalAdd = wiki.addTiddler.bind(wiki);

	wiki.addTiddler = function (tiddler) {
		var result = originalAdd(tiddler);

		if (
			!interrupted &&
			tiddler.fields.title === title &&
			JSON.parse(tiddler.fields.text).charter.status.phase ===
				"complete"
		) {
			interrupted = true;
			throw new Error("Interrupted after materializing the owner");
		}

		return result;
	};

	environment = open();
	var journalTitle;

	try {
		environment.start();

		var inspection = environment.dispatcher.inspect();
		var retention = environment.runtime.inspect().retention;
		var retained = retention.retained.find(function (entry) {
			return entry.title === title;
		});
		var blockers = environment.dispatcher.materializationBlockers({
			title: title,
			persistent: true
		});

		assert(
			interrupted &&
				readyCount === 1 &&
				inspection.errors.length === 1 &&
				inspection.errors[0].phase === "commit",
			"The scenario did not interrupt accepted materialization: " +
				JSON.stringify(inspection)
		);

		assert(
			retention.complete &&
				retained &&
				retained.reasons.some(function (reason) {
					return reason.kind === "accepted-plan-owner";
				}) &&
				blockers.length === 1,
			"The interrupted accepted plan did not retain its owner: " +
				JSON.stringify(retention)
		);

		journalTitle = blockers[0];

		assert(
			!!wiki.getTiddler(title) &&
				wiki.getTiddler(journalTitle)
					.fields["clerus-custody"] === "user" &&
				inspection.collection &&
				inspection.collection.blocked.length === 0 &&
				inspection.collection.removed.indexOf(title) === -1,
			"Automatic collection discarded paused accepted work"
		);

		environment.dispatcher.scan();

		assert(
			readyCount === 1 && !!wiki.getTiddler(title),
			"Another scan reactivated or collected the blocked owner"
		);
	} finally {
		wiki.addTiddler = originalAdd;
		environment.stop();
	}

	// Explicitly authorize recovery. The already applied owner effect
	// must be recognized before ordinary activation and collection.
	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(journalTitle),
		{ "clerus-custody": fixture.platform }
	));

	environment = open();

	try {
		environment.start();

		assert(
			!wiki.getTiddler(journalTitle) &&
				!wiki.getTiddler(title) &&
				readyCount === 2 &&
				environment.dispatcher.inspect().errors.length === 0,
			"Recovery did not release the completed owner for collection: " +
				JSON.stringify(environment.dispatcher.inspect())
		);
	} finally {
		environment.stop();
	}
}


function unknownWalSemanticsPreventCollection(tw) {
	check("unknown-flow-field");
	check("pending-identity");
	check("unknown-plan-field");

	function check(intervention) {
		var fixture = collectionFixture(tw);
		var owner = fixture.add("wal-owner");
		var orphan = fixture.add("wal-orphan");
		var platform = fixture.platform;
		var title =
			"$:/clerus/wal/" + platform + "/unknown-semantics";
		var body;

		if (intervention === "unknown-plan-field") {
			var baseline = effects.capture(
				fixture.wiki.getTiddler(owner)
			);
			var after = clone(baseline);
			var registry = JSON.parse(after.text);

			registry.charter.status = { phase: "complete" };
			after.text = JSON.stringify(registry);

			body = {
				version: 1,
				platform: platform,
				owner: {
					title: owner,
					executor: "spec-collection",
					state: baseline
				},
				plan: {
					version: 1,
					effects: [{
						version: 1,
						kind: "tiddler-put",
						title: owner,
						before: baseline,
						after: after
					}],
					messages: [],
					futureObligations: [{ recipient: orphan }]
				}
			};
		} else {
			var message = messageEffects.create({
				id: "retention-schema-message",
				message: "order",
				source: {
					title: owner,
					executor: "spec-collection",
					platform: platform
				},
				recipient: {
					title: orphan,
					executor: "spec-collection",
					platform: platform
				},
				registry: {}
			}, documentFlow.loadRules(specificationModules({})));

			body = {
				version: 1,
				kind: "flow",
				platform: platform,
				active: null,
				pending: [clone(message)],
				seen: {},
				errors: []
			};

			body.seen[message.id] = clone(message);

			if (intervention === "unknown-flow-field") {
				body.futureObligations = [{ recipient: orphan }];
			} else {
				body.seen[message.id].recipient.title = owner;
			}
		}

		var fields = {
			title: title,
			type: "application/json",
			"clerus-custody": "user",
			text: JSON.stringify(body)
		};

		if (body.kind === "flow") {
			fields["clerus-wal-kind"] = "flow";
		}

		fixture.wiki.addTiddler(new tw.Tiddler(fields));

		var before = effects.capture(
			fixture.wiki.getTiddler(title)
		);
		var retention = fixture.runtime.inspect().retention;
		var collection = jobCollection.collect(fixture.runtime);

		assert(
			!retention.complete &&
				retention.candidates.length === 0 &&
				collection.removed.length === 0 &&
				collection.blocked.indexOf("incomplete-retention") !== -1,
			"Unknown or inconsistent WAL allowed collection after " +
				intervention + ": " + JSON.stringify(retention)
		);

		assert(
			!!fixture.wiki.getTiddler(owner) &&
				!!fixture.wiki.getTiddler(orphan) &&
				sameJson(
					effects.capture(fixture.wiki.getTiddler(title)),
					before
				),
			"Conservative analysis changed protected facts"
		);
	}
}


function collectionRejectsUnsupportedTitleDocuments(tw) {
	var fixture = collectionFixture(tw);
	var title = fixture.add("unsupported-title", {
		document: "$:/clerus/unsupported-resource"
	});

	var before = effects.capture(fixture.wiki.getTiddler(title));
	var result = jobCollection.collect(fixture.runtime);

	assert(
		result.removed.length === 0 &&
			result.skipped.some(function (item) {
				return item.title === title &&
					item.reason === "unsupported-document-destruction";
			}) &&
			sameJson(
				effects.capture(fixture.wiki.getTiddler(title)),
				before
			),
		"Collection treated an unsupported string as a title document: " +
			JSON.stringify(result)
	);
}

exports.run = async function (tw) {
	var cases = [
		{
			name: "context: copies and revocation",
			run: testContext
		},
		{
			name: "hierarchy: cycles and ephemeral superiors",
			run: testHierarchy
		},
		{
			name: "orders: establishment before ordinary delivery",
			run: function () {
				return testOrders(tw, false);
			}
		},
		{
			name: "orders: duplicate filing dismisses recipient",
			run: function () {
				return testOrders(tw, true);
			}
		},
		{
			name: "missions: aliases and conflicting holders",
			run: testMissionAudit
		},
		{
			name: "missions: project change, disappearance and restoration",
			run: function () {
				return testMissionLifecycle(tw);
			}
		},
		{
			name: "missions: conflicting holders cannot read the task",
			run: function () {
				return testMissionConflictRead(tw);
			}
		},
		{
			name: "missions: nested roles and direct-superior invariant",
			run: function () {
				return testNestedMissions(tw);
			}
		},
		{
			name: "roles: canonical URI serialization",
			run: testRolePaths
		},
		{
			name: "projects: custody, child creation and safe keys",
			run: function () {
				return testProjectWrites(tw);
			}
		},
		{
			name: "staff transfer: titles preserve the assigned subtree",
			run: function () {
				return testStaffTransfer(tw, true);
			}
		},
		{
			name: "staff transfer: missing titles detach only the illegal branch",
			run: function () {
				return testStaffTransfer(tw, false);
			}
		},
		{
			name: "reports: returned assignment preserves staff authority when titles are copied",
			run: function () {
				return testStaffReport(tw, true);
			}
		},
		{
			name: "reports: return without titles revokes staff authority without lower writes",
			run: function () {
				return testStaffReport(tw, false);
			}
		},
		{
			name: "documents: transfer and receipt policies",
			run: testDocumentFlow
		},
		{
			name: "reports: memo delivery preserves the addressing assignment",
			run: function () {
				return testMemoReport(tw);
			}
		},
		{
			name: "tiddlers: creation, change, deletion and context revocation",
			run: function () {
				return testOrdinaryTiddlerObservation(tw);
			}
		},
		{
			name: "filters: current membership authorizes title issuance",
			run: function () {
				return testFilterTitleIssuance(tw);
			}
		},
		{
			name: "warrants: operation, field, filter and custody restrictions",
			run: function () {
				return testWarrantWrites(tw);
			}
		},
		{
			name: "warrants: templates exclusively determine created tiddlers",
			run: function () {
				return testTemplateCreation(tw);
			}
		},
		{
			name: "effects: serialization, replay and stale-state protection",
			run: function () {
				return testEffectMaterialization(tw);
			}
		},
		{
			name: "effects: lifecycle transitions preserve unrelated fields",
			run: function () {
				return testLifecycleFieldPreservation(tw);
			}
		},
		{
			name: "plans: read-your-writes, folding, commit and abort",
			run: function () {
				return testWorkPlan(tw);
			}
		},
		{
			name: "plans: preflight rejects conflicts before materialization",
			run: function () {
				return testWorkPlanPreflight(tw);
			}
		},
		{
			name: "plans: recovery after interruption before a put",
			run: function () {
				return testInterruptedWorkPlan(tw, "put", "before");
			}
		},
		{
			name: "plans: recovery after interruption after a put",
			run: function () {
				return testInterruptedWorkPlan(tw, "put", "after");
			}
		},
		{
			name: "plans: recovery after interruption before a deletion",
			run: function () {
				return testInterruptedWorkPlan(tw, "delete", "before");
			}
		},
		{
			name: "plans: recovery after interruption after a deletion",
			run: function () {
				return testInterruptedWorkPlan(tw, "delete", "after");
			}
		},
		{
			name: "persistent reactions: registry changes commit after return",
			run: function () {
				return testPersistentRegistryReaction(tw, false);
			}
		},
		{
			name: "persistent reactions: executor failure aborts registry changes",
			run: function () {
				return testPersistentRegistryReaction(tw, true);
			}
		},
		{
			name: "WAL: recovery before registry materialization",
			run: function () {
				return testRegistryWalRecovery(tw, false);
			}
		},
		{
			name: "WAL: recovery after registry materialization",
			run: function () {
				return testRegistryWalRecovery(tw, true);
			}
		},
		{
			name: "WAL: custody loss pauses recovery without overwriting the owner",
			run: function () {
				return testRegistryWalCustody(tw);
			}
		},
		{
			name: "persistent lifecycle: suspension preserves missions and resumes",
			run: function () {
				return testPersistentSuspension(tw);
			}
		},
		{
			name: "persistent lifecycle: WAL recovery precedes activation",
			run: function () {
				return testRecoveryBeforeActivation(tw);
			}
		},
		{
			name: "persistent writes: external target and registry commit together",
			run: function () {
				return testPersistentExternalWrite(tw, false);
			}
		},
		{
			name: "persistent writes: reaction failure aborts external changes",
			run: function () {
				return testPersistentExternalWrite(tw, true);
			}
		},
		{
			name: "WAL: recovery completes a partially materialized external write",
			run: function () {
				return testExternalWalRecovery(tw);
			}
		},
		{
			name: "persistent deletion: virtual absence commits without owner changes",
			run: function () {
				return testPersistentExternalDeletion(tw, false);
			}
		},
		{
			name: "persistent deletion: executor failure preserves the target",
			run: function () {
				return testPersistentExternalDeletion(tw, true);
			}
		},
		{
			name: "WAL: external-only plan checks owner before registration",
			run: function () {
				return testExternalWalOwnerGuard(tw, "registration");
			}
		},
		{
			name: "WAL: external-only recovery rejects a changed warrant",
			run: function () {
				return testExternalWalOwnerGuard(tw, "recovery");
			}
		},
		{
			name: "WAL: completed external deletion preserves the unchanged owner",
			run: function () {
				return testExternalDeletionWalRecovery(tw);
			}
		},
		{
			name: "persistent creation: template object and title commit together",
			run: function () {
				return testPersistentTemplateCreation(tw, false);
			}
		},
		{
			name: "persistent creation: executor failure leaves neither object nor title",
			run: function () {
				return testPersistentTemplateCreation(tw, true);
			}
		},
		{
			name: "WAL: template creation recovers before either effect",
			run: function () {
				return testTemplateCreationWalRecovery(tw, false);
			}
		},
		{
			name: "WAL: template creation recovers after object creation",
			run: function () {
				return testTemplateCreationWalRecovery(tw, true);
			}
		},
		{
			name: "templates: planned creation permits explicitly authorized patch",
			run: function () {
				return testPlannedTemplateFollowup(tw, "patch");
			}
		},
		{
			name: "templates: missing followup permission preserves template content",
			run: function () {
				return testPlannedTemplateFollowup(tw, "denied");
			}
		},
		{
			name: "templates: authorized create/delete leaves only the title document",
			run: function () {
				return testPlannedTemplateFollowup(tw, "delete");
			}
		},
		{
			name: "persistent projects: repeated child creation uses virtual state",
			run: function () {
				return testPersistentProjectParts(tw, "success");
			}
		},
		{
			name: "persistent projects: executor failure preserves the project",
			run: function () {
				return testPersistentProjectParts(tw, "fail");
			}
		},
		{
			name: "persistent projects: project custody remains independently required",
			run: function () {
				return testPersistentProjectParts(tw, "foreign");
			}
		},
		{
			name: "persistent missions: newly created roles support nested work",
			run: function () {
				return testPlannedMissionCreation(tw, "success");
			}
		},
		{
			name: "persistent missions: reaction failure discards tasks and assignments",
			run: function () {
				return testPlannedMissionCreation(tw, "fail");
			}
		},
		{
			name: "persistent missions: occupied role is replaced without rewriting its holder",
			run: function () {
				return testPlannedMissionCreation(tw, "occupied");
			}
		},
		{
			name: "persistent missions: failed replacement preserves former authority",
			run: function () {
				return testPlannedMissionCreation(tw, "occupied-fail");
			}
		},
		{
			name: "messages: stable envelope and anonymous order event",
			run: function () {
				return testOfficialMessageEffect(tw);
			}
		},
		{
			name: "plans: message identity and rejection of incomplete materialization",
			run: function () {
				return testMessagePlanning(tw);
			}
		},
		{
			name: "flows: recovery materializes the root plan and registers messages",
			run: function () {
				return testFlowWalRecovery(tw, "root-plan");
			}
		},
		{
			name: "flows: pending message survives recovery with stable identity",
			run: function () {
				return testFlowWalRecovery(tw, "pending-message");
			}
		},
		{
			name: "flows: accepted recipient plan survives without redispatch",
			run: function () {
				return testFlowWalRecovery(tw, "accepted-plan");
			}
		},
		{
			name: "persistent flows: order delivery commits the recipient plan",
			run: function () {
				return testPersistentFlowDispatch(tw, "success");
			}
		},
		{
			name: "persistent flows: recipient failure preserves flow evidence",
			run: function () {
				return testPersistentFlowDispatch(tw, "failure");
			}
		},
		{
			name: "persistent flows: startup recovers and deduplicates pending delivery",
			run: function () {
				return testPersistentFlowDispatch(tw, "recovery");
			}
		},
		{
			name: "persistent defer: order schedules one independent tick",
			run: function () {
				return testPersistentDeferredEvent(tw, "success");
			}
		},
		{
			name: "persistent defer: pending tick survives startup",
			run: function () {
				return testPersistentDeferredEvent(tw, "recovery");
			}
		},
		{
			name: "persistent defer: failed tick preserves evidence and aborts changes",
			run: function () {
				return testPersistentDeferredEvent(tw, "failure");
			}
		},
		{
			name: "persistent reports: deferred upward chain shares a flow",
			run: function () {
				return testPersistentReportChain(tw, "success");
			}
		},
		{
			name: "persistent reports: restored tick starts the upward chain",
			run: function () {
				return testPersistentReportChain(tw, "recovery");
			}
		},
		{
			name: "persistent reports: forwarding failure emits no successor",
			run: function () {
				return testPersistentReportChain(tw, "failure");
			}
		},
		{
			name: "persistent appointment: contract becomes charter before initialization",
			run: function () {
				return testPersistentAppointment(tw, "success");
			}
		},
		{
			name: "persistent appointment: failed initialization remains suspended",
			run: function () {
				return testPersistentAppointment(tw, "failure");
			}
		},
		{
			name: "persistent appointment: recovery recognizes birth and delivers its order",
			run: function () {
				return testPersistentAppointment(tw, "recovery");
			}
		},
		{
			name: "persistent appointment: transfers a newly planned child assignment",
			run: function () {
				return testPersistentAssignedAppointment(tw, "success");
			}
		},
		{
			name: "persistent appointment: initialization failure preserves the role",
			run: function () {
				return testPersistentAssignedAppointment(tw, "failure");
			}
		},
		{
			name: "persistent appointment: transfer consumes every assignment alias",
			run: function () {
				return testPersistentAssignedAppointment(tw, "aliases");
			}
		},
		{
			name: "persistent appointment: transferring a staffed role leaves lower documents inactive",
			run: function () {
				return testPersistentAssignedAppointment(tw, "staffed");
			}
		},
		{
			name: "assigned recovery: source changed before recipient birth",
			run: function () {
				return testAssignedAppointmentRecovery(tw, "source-only");
			}
		},
		{
			name: "assigned recovery: recipient born before order registration",
			run: function () {
				return testAssignedAppointmentRecovery(tw, "born");
			}
		},
		{
			name: "assigned recovery: initialization plan accepted before materialization",
			run: function () {
				return testAssignedAppointmentRecovery(tw, "accepted");
			}
		},
		{
			name: "assigned recovery: initialization applied before journal cleanup",
			run: function () {
				return testAssignedAppointmentRecovery(tw, "initialized");
			}
		},
		{
			name: "persistent staffing: copied titles preserve the whole subtree",
			run: function () {
				return testPersistentStaffedAppointment(tw, "preserve");
			}
		},
		{
			name: "persistent staffing: transfer without titles revokes authority without lower writes",
			run: function () {
				return testPersistentStaffedAppointment(tw, "without-titles");
			}
		},
		{
			name: "persistent staffing: recovery preserves the transferred subtree",
			run: function () {
				return testPersistentStaffedAppointment(tw, "recovery");
			}
		},
		{
			name: "linked missions: one upper binding revokes the whole subtree",
			run: testLinkedSubtreeRevocation
		},
		{
			name: "linked missions: parent transfer preserves unchanged child documents",
			run: testLinkedParentTransfer
		},
		{
			name: "linked missions: newest present root wins",
			run: testLinkedRootSelection
		},
		{
			name: "linked missions: aliases and ambiguous holders are distinguished",
			run: testLinkedAssignmentCopies
		},
		{
			name: "linked missions: matching labels still require subordination",
			run: testLinkedSubordination
		},
		{
			name: "linked issuance: every parent alias advances together",
			run: testLinkedIssuanceAliases
		},
		{
			name: "linked issuance: revoked labels are never reused",
			run: testLinkedIssuanceAfterRevocation
		},
		{
			name: "linked issuance: nested namespaces and large counters",
			run: testLinkedNestedIssuance
		},
		{
			name: "linked issuance: conflicting aliases fail without mutation",
			run: testLinkedIssuanceConflict
		},
		{
			name: "linked runtime: local revocation leaves stale documents without authority",
			run: function () {
				return testLinkedRuntimeIssuance(tw, false);
			}
		},
		{
			name: "linked runtime: planned issuance and revocation share virtual state",
			run: function () {
				return testLinkedRuntimeIssuance(tw, true);
			}
		},
		{
			name: "linked observation: revocation and restoration notify unchanged documents",
			run: function () {
				return testLinkedMissionObservation(tw);
			}
		},
		{
			name: "linked appointment: ephemeral transfer preserves identity and stale documents",
			run: function () {
				return testLinkedAppointmentTransfer(tw, false);
			}
		},
		{
			name: "linked appointment: persistent transfer preserves identity and stale documents",
			run: function () {
				return testLinkedAppointmentTransfer(tw, true);
			}
		},
		{
			name: "linked lifecycle: local resignation notifies descendants without lower writes",
			run: function () {
				return testLinkedDetachmentLifecycle(tw, false);
			}
		},
		{
			name: "linked lifecycle: dismissal revokes authority without rewriting descendants",
			run: function () {
				return testLinkedDetachmentLifecycle(tw, true);
			}
		},
		{
			name: "flows: interrupted materialization retains the accepted plan",
			run: function () {
				return testFlowInterruptedMaterialization(tw);
			}
		},
		{
			name: "commit barrier: failure preserves owner and blocks activation until recovery",
			run: function () {
				return testCommitFailurePreservesOwner(tw);
			}
		},
		{
			name: "agent call: persisted request and response precede transport and notification",
			run: function () {
				return testAgentCall(tw, false);
			}
		},
		{
			name: "agent call: aborted reaction never calls transport",
			run: function () {
				return testAgentCall(tw, true);
			}
		},
		{
			name: "agent call: restored running operation becomes uncertain without retry",
			run: function () {
				return testInterruptedAgentCall(tw);
			}
		},
		{
			name: "agent call: replaced document ignores the old response",
			run: function () {
				return testAgentLateResponse(tw, "replacement");
			}
		},
		{
			name: "agent call: custody loss prevents response commit",
			run: function () {
				return testAgentLateResponse(tw, "custody");
			}
		},
		{
			name: "agent call: stopped driver ignores late response and does not retry",
			run: function () {
				return testAgentLateResponse(tw, "stopped");
			}
		},
		{
			name: "agent call: response plan recovers before owner update",
			run: function () {
				return testAgentResponseRecovery(tw, "before");
			}
		},
		{
			name: "agent call: response plan recovers after owner update",
			run: function () {
				return testAgentResponseRecovery(tw, "after");
			}
		},
		{
			name: "OpenRouter: request, metadata, safe failures and no retries",
			run: testOpenRouterTransport
		},
		{
			name: "agent session: atomic send, history, receipt deduplication and binding",
			run: testAgentSessionContext
		},
		{
			name: "agent wiki tools: capability-backed writes remain planned",
			run: function () {
				return testAgentWikiToolPlanning(tw, false);
			}
		},
		{
			name: "agent wiki tools: executor failure aborts tool writes",
			run: function () {
				return testAgentWikiToolPlanning(tw, true);
			}
		},
		{
			name: "warrant missions: ownership, generations, aliases and planned removal",
			run: function () {
				return testWarrantMissionScope(tw);
			}
		}
	];

	var results = [];

	for (var i = 0; i < cases.length; i++) {
		var test = cases[i];

		try {
			await test.run();

			results.push({
				name: test.name,
				passed: true,
				error: null
			});
		} catch (error) {
			results.push({
				name: test.name,
				passed: false,
				error: String(error && error.stack || error)
			});
		}
	}

	return {
		passed: results.every(function (result) {
			return result.passed;
		}),
		results: results
	};
};