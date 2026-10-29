/*\
title: $:/plugins/clerus/core/tests.js
type: application/javascript
module-type: library
\*/

"use strict";

var contexts =
	require("$:/plugins/clerus/core/context.js");
var basicDocuments =
	require("$:/plugins/clerus/core/documents-basic.js");
var missions =
	require("$:/plugins/clerus/core/missions.js");
var missionLinks =
	require("$:/plugins/clerus/core/mission-links.js");
var missionIssuance =
	require("$:/plugins/clerus/core/mission-issuance.js");
var Runtime =
	require("$:/plugins/clerus/core/runtime.js").Runtime;
var Dispatcher =
	require("$:/plugins/clerus/core/dispatcher.js").Dispatcher;
var effects =
	require("$:/plugins/clerus/core/effects.js");
var tiddlerWriter =
	require("$:/plugins/clerus/core/tiddler-writer.js");
var warrantMission =
	require("$:/plugins/clerus/core/warrant-mission.js");
var operationStates =
	require("$:/plugins/clerus/core/state.js");
var workPlans =
	require("$:/plugins/clerus/core/work-plan.js");
var warrantDocument =
	require("$:/plugins/clerus/core/document-warrant.js");
var documentFlow =
	require("$:/plugins/clerus/core/document-flow.js");
var messageEffects =
	require("$:/plugins/clerus/core/message-effect.js");
var FlowWal =
	require("$:/plugins/clerus/core/flow-wal.js").FlowWal;
var agentCallDocument =
	require("$:/plugins/clerus/core/document-agent-call.js");
var StatusObserver =
	require("$:/plugins/clerus/core/status-observer.js").StatusObserver;
var hierarchy =
	require("$:/plugins/clerus/core/hierarchy.js");
var jobRetention =
	require("$:/plugins/clerus/core/job-retention.js");
var Wal = require("$:/plugins/clerus/core/wal.js").Wal;
var jobCollection =
	require("$:/plugins/clerus/core/job-collection.js");
var browserCredentials =
	require("$:/plugins/clerus/core/browser-credentials.js");
var projectLauncher =
	require("$:/plugins/clerus/core/project-launch.js");
var projectProbe =
	require("$:/plugins/clerus/core/executor-project-probe.js");
var projectAnswer =
	require("$:/plugins/clerus/core/executor-project-answer.js");
var agentSessionDocument =
	require("$:/plugins/clerus/core/document-agent-session.js");
var sourceSnapshots =
	require("$:/plugins/clerus/core/source-snapshot.js");
var agentMessages =
	require("$:/plugins/clerus/core/agent-messages.js");


function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function assertThrows(fn, fragment) {
	var caught;
	var didThrow = false;

	try {
		fn();
	} catch (error) {
		didThrow = true;
		caught = error;
	}

	assert(didThrow, "Expected an exception");

	if (fragment) {
		assert(
			String(caught && caught.message || caught)
				.indexOf(fragment) !== -1,
			"Unexpected exception: " + String(caught)
		);
	}
}

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function sameJson(left, right) {
	if (left === right) {
		return true;
	}

	if (
		left === null ||
		right === null ||
		typeof left !== "object" ||
		typeof right !== "object"
	) {
		return false;
	}

	if (Array.isArray(left) || Array.isArray(right)) {
		return (
			Array.isArray(left) &&
			Array.isArray(right) &&
			left.length === right.length &&
			left.every(function (value, index) {
				return sameJson(value, right[index]);
			})
		);
	}

	var leftKeys = Object.keys(left).sort();
	var rightKeys = Object.keys(right).sort();

	return (
		leftKeys.length === rightKeys.length &&
		leftKeys.every(function (key, index) {
			return key === rightKeys[index] &&
				sameJson(left[key], right[key]);
		})
	);
}

function waitFor(predicate, timeout, description) {
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
				reject(new Error(
					"Timed out waiting for " +
						(description || "the scenario")
				));
				return;
			}

			setTimeout(check, 5);
		}

		check();
	});
}

/*
SPECIFICATION MACHINERY
-----------------------

These helpers load production modules and manage runtime lifetime.

They do not create jobs, issue grants, authorize operations or
predict outcomes. Those facts must remain visible in the scenarios.
*/

function specificationModules(executors, documents) {
	documents = documents || [];

	return {
		forEachModuleOfType: function (type, callback) {
			if (type === "clerus-document") {
				callback("basic-documents", basicDocuments);

				documents.forEach(function (document, index) {
					callback("spec-document-" + index, document);
				});
			}

			if (type === "clerus-executor") {
				Object.keys(executors).forEach(function (name) {
					callback(name, {
						name: name,
						browser: executors[name],
						node: executors[name]
					});
				});
			}
		}
	};
}

function specificationEnvironment(tw, options) {
	var runtime = new Runtime({
		wiki: options.wiki,
		platform: options.platform
	});

	var dispatcherOptions = {
		runtime: runtime,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler,
		autoCollectJobs: options.autoCollectJobs === true,
		modules: specificationModules(
			options.executors || {},
			options.documents
		)
	};

	if (options.agentTransport) {
		dispatcherOptions.agentTransport = options.agentTransport;
	}

	var dispatcher = new Dispatcher(dispatcherOptions);

	return {
		runtime: runtime,
		dispatcher: dispatcher,

		start: function () {
			runtime.start();
			dispatcher.start();
		},

		stop: function () {
			dispatcher.stop();
			runtime.stop();
		}
	};
}

/*
CLERUS
======

The proactive half of TiddlyWiki.

Tiddlers contain the authoritative state of the organization.
The runtime derives a current perspective from that state:
active assignments, relationships, subscriptions and legal actions.

Derived facts belong to the perspective, not to the objects from
which they were inferred. Losing authority need not rewrite the
document that once granted it.

Executors react synchronously to dispatched events.

One dispatch pass drains the activation tree causally connected
to its initial event through official messages. Reactions, plan
acceptance and local materialization finish before the pass returns,
unless an explicit failure or materialization blocker prevents
completion. No asynchronous continuation silently completes the
remaining work.

Reports may travel upward and produce orders flowing downward
within the same synchronous wave. Causal continuity does not by
itself make the whole wave one transaction.

Deferral ends the current causal wave. Its tick starts a separate
dispatch pass.

Executors do not return asynchronous continuations. Promises belong
inside document implementations; their completion produces a
separate event addressed to the owner of the corresponding registry.

Durable working state belongs to job registries, not to executor
instances.

Document forms expose capabilities within a reaction's context.
They observe relevant circumstances and constrain changes to them.

Thus the working cycle is:

    authoritative facts change
        → the runtime derives a new perspective
        → changed circumstances produce events
        → executors react through document capabilities
        → legal effects change authoritative facts

The runtime does not persist every intermediate inference.
It materializes service state when that state is itself necessary
for correctness: for example, an accepted unfinished obligation.

Ephemeral reactions apply effects immediately.
Persistent reactions first propose work in an isolated plan.
These are different reliability contracts, not merely different
storage lifetimes.

Orders and reports move documents through an organization.
Persistent official flows retain accepted work across interruption.

Browser and node are autonomous platforms. Custody identifies the
responsible writer of a tiddler; the other platform and the human
remain part of its observable environment.

These scenarios exercise one local runtime at a time.
They do not establish distributed consensus or physically atomic
multi-tiddler writes.

Recovery preserves accepted obligations without gaining authority
to overwrite conflicting intervention.

External effects impose a further limit: an unknown outcome must
remain unknown rather than being silently repeated.


READING THIS FILE
-----------------

Read the chapters in order.

Each chapter states a law and demonstrates it through production
operations. Fixtures describe initial facts; they do not precompute
the authority or outcome under examination.

The complete regression suite remains independently available.
This file selects architectural witnesses rather than enumerating
every boundary case.
*/

function delegationFixture(tw) {
	var project = "Architectural Specification Project";
	var director = "$:/clerus/jobs/spec-director";
	var manager = "$:/clerus/jobs/spec-manager";
	var worker = "$:/clerus/jobs/spec-worker";

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

	var jobs = [
		{
			title: director,
			persistent: true,
			registry: {
				mission: grant([], "10", {
					department: "11"
				}),
				subordinate: manager
			}
		},
		{
			title: manager,
			persistent: true,
			registry: {
				mission: grant(["department"], "11", {
					item: "12"
				}),
				subordinate: worker
			}
		},
		{
			title: worker,
			persistent: true,
			registry: {
				mission: grant(["department", "item"], "12")
			}
		}
	];

	var wiki = new tw.Wiki();

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		text: JSON.stringify({
			task: { name: "root task" },
			parts: {
				department: {
					task: { name: "department task" },
					parts: {
						item: {
							task: { name: "item task" },
							parts: {}
						}
					}
				}
			}
		})
	}));

	return {
		wiki: wiki,
		jobs: jobs,
		director: jobs[0],
		manager: jobs[1],
		worker: jobs[2]
	};
}

function readAssignment(fixture, holder, key) {
	return missions.read(
		fixture.wiki,
		fixture.jobs,
		holder.title,
		holder.registry[key || "mission"]
	);
}

function activeAssignments(fixture) {
	return missionLinks.evaluate(fixture.jobs).active;
}


/*
1. AUTHORITATIVE FACTS AND DERIVED PERSPECTIVE
=============================================

A mission document remains the same stored document when an upper
grant changes. Its authority and readability do not.

The observer detects that change without storing subscription
history or derived authority in the subordinate registries.

A fresh observer reconstructs its baseline from current facts.
It does not require persisted notification bookkeeping.
*/

function authorityChangesWithoutRewritingItsEvidence(tw) {
	var fixture = delegationFixture(tw);
	var observer = new StatusObserver();

	function collect(currentObserver) {
		return currentObserver.collect(
			fixture.jobs,
			function () {
				return { readable: true, status: {} };
			},
			function (holder, document) {
				return missions.read(
					fixture.wiki,
					fixture.jobs,
					holder,
					document
				);
			},
			function () {
				throw new Error("Unexpected ordinary title subscription");
			}
		).filter(function (event) {
			return event.key === "mission";
		});
	}

	assert(
		readAssignment(fixture, fixture.worker).readable,
		"The initial delegation is not readable"
	);

	assert(
		collect(observer).length === 0,
		"Establishing a baseline emitted a change"
	);

	var lowerBefore = JSON.stringify(fixture.jobs.slice(1));

	delete fixture.director.registry.mission.children.department;

	var events = collect(observer);

	assert(
		events.length === 2 &&
			events.some(function (event) {
				return event.recipient === fixture.manager.title;
			}) &&
			events.some(function (event) {
				return event.recipient === fixture.worker.title;
			}),
		"The changed perspective did not notify both descendants"
	);

	assert(
		!readAssignment(fixture, fixture.manager).readable &&
			!readAssignment(fixture, fixture.worker).readable,
		"The new perspective retained revoked task access"
	);

	assert(
		JSON.stringify(fixture.jobs.slice(1)) === lowerBefore,
		"Deriving authority or notifications rewrote lower evidence"
	);

	assert(
		collect(observer).length === 0,
		"Unchanged facts repeatedly emitted the same change"
	);

	assert(
		collect(new StatusObserver()).length === 0,
		"A fresh perspective required persisted observation history"
	);
}


/*
2. OBSERVATION TURNS CHANGED FACTS INTO WORK
===========================================

A mission observes its task in the project.

Project edits, disappearance and restoration produce document
events, not repeated activation of the executor.

Each reaction receives a fresh context. The executor may project
its observation into its own status, but does not own the observed
project merely because it can read the task.
*/

async function projectChangesDriveDocumentReactions(tw) {
	var fixture = delegationFixture(tw);
	var wiki = fixture.wiki;
	var platform = tw.browser ? "browser" : "node";
	var director = fixture.director;
	var project = director.registry.mission.project;
	var trace = [];
	var savedMission;

	function writeProject(message) {
		wiki.addTiddler(new tw.Tiddler({
			title: project,
			type: "application/json",
			"clerus-custody": "user",
			text: JSON.stringify({
				task: { message: message },
				parts: {}
			})
		}));
	}

	writeProject("initial");

	wiki.addTiddler(new tw.Tiddler({
		title: director.title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "spec-observation",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			mission: director.registry.mission
		})
	}));

	function status() {
		return JSON.parse(
			wiki.getTiddler(director.title).fields.text
		).charter.status;
	}

	function react(event, operational) {
		if (
			event.type !== "ready" &&
			!(
				event.type === "document-change" &&
				event.key === "mission"
			)
		) {
			return;
		}

		if (savedMission) {
			assertThrows(function () {
				savedMission.inspect();
			}, "closed");
		}

		var mission = operational.get("mission");
		var view = mission.inspect();

		trace.push(event.type);
		savedMission = mission;

		if (view.readable) {
			var task = mission.task();
			task.message = "Local mutation";

			assert(
				mission.task().message !== "Local mutation",
				"Reading a project task exposed mutable state"
			);
		}

		operational.get("charter").setStatus({
			phase: view.readable ? "assigned" : "blocked",
			message: view.readable ? view.task.message : null
		});
	}

	var environment = specificationEnvironment(tw, {
		wiki: wiki,
		platform: platform,
		executors: {
			"spec-observation": react
		}
	});

	async function expect(phase, message) {
		await waitFor(function () {
			var current = status();

			return (
				current.phase === phase &&
				current.message === message
			) || environment.dispatcher.inspect().errors.length > 0;
		}, 2000, "mission observation: " + phase + " / " + message);

		assert(
			environment.dispatcher.inspect().errors.length === 0,
			"Observation failed: " +
				JSON.stringify(environment.dispatcher.inspect().errors)
		);

		assert(
			status().phase === phase && status().message === message,
			"The executor did not observe the current project state"
		);
	}

	try {
		environment.start();

		await expect("assigned", "initial");

		writeProject("updated");
		await expect("assigned", "updated");

		wiki.deleteTiddler(project);
		await expect("blocked", null);

		assert(
			JSON.parse(wiki.getTiddler(director.title).fields.text)
				.mission.form === "mission",
			"Project disappearance removed the assignment document"
		);

		writeProject("restored");
		await expect("assigned", "restored");

		assert(
			trace.join(",") ===
				"ready,document-change,document-change,document-change",
			"Changed circumstances caused reactivation or duplicate reactions"
		);

		assert(
			JSON.parse(wiki.getTiddler(project).fields.text)
				.task.message === "restored",
			"Observation changed the user-owned project"
		);

		assertThrows(function () {
			savedMission.inspect();
		}, "closed");
	} finally {
		environment.stop();
	}
}


/*
3. DOCUMENTS EXPOSE BOUNDED CAPABILITIES
================================================

A stored registry is data. Opening a context exposes the operations
associated with its documents.

Those operations do not lend mutable references to stored state.
An executor must write through the document API.

The context bounds the lifetime of the resulting capabilities.
Keeping a form does not preserve permission after the reaction ends.
*/

function scopedDocuments() {
	var forms = contexts.loadForms({
		forEachModuleOfType: function (type, callback) {
			if (type === "clerus-document") {
				callback("basic-documents", basicDocuments);
			}
		}
	});

	var stored = {
		note: {
			form: "memo",
			data: { value: 1 }
		}
	};
	var writes = 0;

	var scope = contexts.openContext(stored, forms, {
		replace: function (key, document) {
			stored[key] = clone(document);
			writes++;
		}
	});

	try {
		var note = scope.context.get("note");

		// Reading does not grant an alternative mutation path.
		var read = note.data();
		read.value = 99;

		assert(
			note.data().value === 1 &&
				stored.note.data.value === 1 &&
				writes === 0,
			"Mutating a read changed the document"
		);

		// Writing does not retain the caller's mutable object.
		var next = { value: 2 };

		note.setData(next);
		next.value = 99;

		assert(
			note.data().value === 2 &&
				stored.note.data.value === 2 &&
				writes === 1,
			"Document writes did not preserve an isolated value"
		);

		// A saved capability expires with its context.
		scope.close();

		assertThrows(function () {
			note.data();
		}, "closed");

		assertThrows(function () {
			note.setData({ value: 3 });
		}, "closed");

		assert(
			stored.note.data.value === 2 &&
				writes === 1,
			"A closed context allowed a write"
		);
	} finally {
		scope.close();
	}
}


/*
A title reference makes a document addressable.
A warrant authorizes particular operations on particular fields
of currently covered targets.
Custody independently permits the local runtime to modify a target.

None of these substitutes for the others.

A mission-bound warrant adds another requirement: the executor
must locally hold the specified active grant, not merely another
generation of the same role.
*/

function writesRequireIndependentPermissions(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner =
		"$:/temp/clerus/jobs/" + platform + "/spec-write-authority";
	var target = "Architectural Write Target";

	var permission = {
		form: "warrant",
		filter: "[tag[spec-writable]]",
		operations: ["patch"],
		fields: ["text"]
	};

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		tags: ["spec-writable"],
		caption: "Preserved",
		text: "Initial"
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "spec-write-authority",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			document: target,
			permission: permission
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	runtime.start();

	try {
		var job = runtime.inspect().jobs.find(function (candidate) {
			return candidate.title === owner;
		});

		function write(operation, patch) {
			tiddlerWriter.write({
				runtime: runtime,
				Tiddler: tw.Tiddler,
				job: job,
				documentKey: "document",
				title: target,
				warrantKey: "permission",
				warrant: permission,
				operation: operation,
				patch: patch
			});
		}

		function refused(fn, fragment) {
			var before = JSON.stringify(
				effects.capture(wiki.getTiddler(target))
			);

			assertThrows(fn, fragment);

			assert(
				JSON.stringify(
					effects.capture(wiki.getTiddler(target))
				) === before,
				"A refused operation changed its target"
			);
		}

		// With every required basis present, the write is legal.
		write("patch", {
			set: { text: "Authorized" }
		});

		assert(
			wiki.getTiddler(target).fields.text === "Authorized" &&
				wiki.getTiddler(target).fields.caption === "Preserved",
			"The authorized patch failed or changed unrelated fields"
		);

		// Coverage does not authorize every field or operation.
		refused(function () {
			write("patch", {
				set: { caption: "Forbidden" }
			});
		}, "does not allow field");

		refused(function () {
			write("delete");
		}, "does not allow operation");

		// The same warrant cannot overcome foreign custody.
		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(target),
			{ "clerus-custody": "user" }
		));

		refused(function () {
			write("patch", {
				set: { text: "Forbidden" }
			});
		}, "not owned");

		// Restored custody cannot overcome lost filter coverage.
		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(target),
			{
				"clerus-custody": platform,
				tags: []
			}
		));

		refused(function () {
			write("patch", {
				set: { text: "Forbidden" }
			});
		}, "does not cover");

		var registry = JSON.parse(
			wiki.getTiddler(owner).fields.text
		);

		assert(
			registry.document === target,
			"Loss of write authority removed the title reference"
		);
	} finally {
		runtime.stop();
	}
}


/*
The warrant names a grant, not just a project role.

Authorization must also see the reaction's planned registry:
a grant already removed in virtual state cannot keep authorizing
work merely because the materialized registry still contains it.
*/

function warrantsDependOnCurrentMissionAuthority(tw) {
	var fixture = delegationFixture(tw);
	var wiki = fixture.wiki;
	var jobs = fixture.jobs;
	var holder = fixture.manager;
	var platform = tw.browser ? "browser" : "node";

	jobs.forEach(function (job) {
		job.valid = true;
		job.local = true;
		job.owned = true;
		job.custody = platform;
		job.executor = "spec-mission-authority";

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

	var permission = {
		form: "warrant",
		filter: "[all[tiddlers]]",
		operations: ["patch"],
		fields: ["text"],
		mission: {
			project: holder.registry.mission.project,
			role: ["department"],
			link: "11"
		}
	};

	var live = operationStates.live(wiki, tw.Tiddler);

	function authorize(state) {
		warrantMission.authorize({
			runtime: runtime,
			state: state,
			job: holder,
			warrant: permission
		});
	}

	function storeHolder() {
		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(holder.title),
			{ text: JSON.stringify(holder.registry) }
		));
	}

	authorize(live);

	var original = clone(holder.registry);

	// A selected grant is insufficient when its upper path is broken.
	fixture.director.registry.mission.children.department = "99";

	assertThrows(function () {
		authorize(live);
	}, "active mission");

	fixture.director.registry.mission.children.department = "11";

	// A newer, active generation of the same role is not this grant.
	holder.registry.mission.link = "99";
	fixture.director.registry.mission.children.department = "99";
	storeHolder();

	assert(
		readAssignment(fixture, holder).active,
		"The replacement generation is not active"
	);

	assertThrows(function () {
		authorize(live);
	}, "locally held");

	holder.registry = original;
	fixture.director.registry.mission.children.department = "11";
	storeHolder();

	authorize(live);

	var holderBefore = JSON.stringify(
		effects.capture(wiki.getTiddler(holder.title))
	);

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	try {
		var proposed = clone(holder.registry);
		delete proposed.mission;

		plan.patch(holder.title, {
			text: JSON.stringify(proposed)
		});

		assertThrows(function () {
			authorize(operationStates.planned(plan));
		}, "locally held");

		// The materialized grant still authorizes live state.
		authorize(live);

		assert(
			JSON.stringify(
				effects.capture(wiki.getTiddler(holder.title))
			) === holderBefore,
			"Checking planned authority changed materialized state"
		);
	} finally {
		plan.abort();
	}
}


/*
4. POSSESSION IS NOT AUTHORITY
=============================

A mission identifies a project role and a particular grant.
It does not contain the task or permanently authorize its holder.

An active child requires an active immediate parent that selects
its grant. Different holders also need a direct superior relation.

Thus authority depends on the whole path to the selected root.

Aliases within one holder do not multiply authority. Divergent
aliases and multiple holders make a grant ambiguous.

Revocation changes the upper selection, not the subordinate's
stored evidence. Reissuing uses a fresh label so that an old
document cannot regain authority through label reuse.
*/


/*
The hierarchy is a directed acyclic graph, not necessarily a tree.

Its edges are job titles held in operational registries.
Ephemeral jobs cannot supervise persistent jobs.

These structural constraints are distinct from mission authority:
a well-formed hierarchy does not by itself grant a project role.
*/

function hierarchyHasStructuralLimits(tw) {
	var platform = tw.browser ? "browser" : "node";
	var director = "$:/clerus/jobs/spec-hierarchy-director";
	var worker = "$:/clerus/jobs/spec-hierarchy-worker";
	var temporary =
		"$:/temp/clerus/jobs/" + platform + "/spec-hierarchy-temporary";

	var legal = hierarchy.audit([
		{
			title: director,
			persistent: true,
			registry: { subordinate: temporary }
		},
		{
			title: temporary,
			persistent: false,
			registry: {}
		}
	]);

	assert(
		legal.valid,
		"A persistent job could not supervise an ephemeral job"
	);

	var cyclic = hierarchy.audit([
		{
			title: director,
			persistent: true,
			registry: { subordinate: worker }
		},
		{
			title: worker,
			persistent: true,
			registry: { subordinate: director }
		}
	]);

	assert(
		!cyclic.valid &&
			cyclic.violations.some(function (violation) {
				return violation.type === "cycle";
			}),
		"A cyclic organization was accepted"
	);

	var invertedLifetime = hierarchy.audit([
		{
			title: temporary,
			persistent: false,
			registry: { subordinate: worker }
		},
		{
			title: worker,
			persistent: true,
			registry: {}
		}
	]);

	assert(
		!invertedLifetime.valid,
		"An ephemeral job could supervise a persistent job"
	);
}


/*
The facts underlying a legal delegation:

    director --subordinate--> manager --subordinate--> worker
       root                      department              item
         \-- selects "11" ----------/
                                    \-- selects "12" -----/

The project owns the tasks. The jobs hold grants and relationships.

These are plain records, not pre-authorized objects. Every scenario
asks the production evaluator or reader to establish authority.
*/

function delegationRequiresAnActiveParent(tw) {
	var fixture = delegationFixture(tw);
	var manager = fixture.manager;
	var worker = fixture.worker;

	var initial = readAssignment(fixture, worker);

	assert(
		initial.active &&
			initial.readable &&
			initial.task.name === "item task",
		"A legal delegation did not resolve its project task"
	);

	// Matching labels alone cannot establish subordination.
	delete manager.registry.subordinate;

	var unrelated = readAssignment(fixture, worker);

	assert(
		!unrelated.active &&
			!unrelated.readable &&
			unrelated.reason === "invalid-subordination",
		"A matching grant bypassed the superior relationship"
	);

	// Restore the relationship, but remove the immediate parent grant.
	manager.registry.subordinate = worker.title;
	delete manager.registry.mission;

	var parentless = readAssignment(fixture, worker);

	assert(
		!parentless.active &&
			!parentless.readable &&
			parentless.reason === "inactive-parent",
		"A root director substituted for the missing immediate parent"
	);
}


function aliasesDoNotMultiplyAuthority(tw) {
	var fixture = delegationFixture(tw);
	var manager = fixture.manager;

	manager.registry.alias = clone(manager.registry.mission);

	assert(
		activeAssignments(fixture).length === 3,
		"Identical aliases within one holder created ambiguity"
	);

	// Copies cannot disagree about the authority they delegate.
	manager.registry.alias.children.item = "99";

	assert(
		activeAssignments(fixture).length === 1,
		"Divergent aliases remained authoritative"
	);

	manager.registry.alias = clone(manager.registry.mission);

	assert(
		activeAssignments(fixture).length === 3,
		"Repairing an alias did not restore the legal chain"
	);

	// A second holder is not another alias of the first holder.
	fixture.jobs.push({
		title: "$:/clerus/jobs/spec-competing-manager",
		persistent: true,
		registry: {
			mission: clone(manager.registry.mission)
		}
	});

	var ambiguous = missionLinks.evaluate(fixture.jobs);

	assert(
		ambiguous.active.length === 1 &&
			ambiguous.issues.some(function (issue) {
				return issue.type === "ambiguous-holder";
			}),
		"Different holders shared one authoritative grant"
	);

	assert(
		!readAssignment(fixture, manager).readable,
		"An ambiguous holder retained task access"
	);
}


function revokedLabelsAreNotReused(tw) {
	var fixture = delegationFixture(tw);
	var director = fixture.director;

	var first = missionIssuance.issue(
		director.registry,
		"mission",
		"department",
		"first"
	);

	director.registry = first.registry;

	assert(
		readAssignment(fixture, director, "first").active,
		"The newly selected grant is not active"
	);

	var oldGrant = clone(director.registry.first);

	var revoked = missionIssuance.revoke(
		director.registry,
		"mission",
		"department"
	);

	director.registry = revoked.registry;

	assert(
		director.registry.mission.issued === "1" &&
			!readAssignment(fixture, director, "first").active,
		"Revocation lost issuance history or retained authority"
	);

	// Physical cleanup must not erase issuance history.
	delete director.registry.first;

	var second = missionIssuance.issue(
		director.registry,
		"mission",
		"department",
		"second"
	);

	director.registry = second.registry;

	assert(
		second.link !== first.link &&
			director.registry.mission.issued === "2",
		"Reissuance reused a revoked label"
	);

	// Even a later reappearance of the old document is harmless.
	director.registry.stale = oldGrant;

	assert(
		readAssignment(fixture, director, "second").active &&
			!readAssignment(fixture, director, "stale").active,
		"An old document regained authority after reissuance"
	);
}


/*
5. TRANSFER MOVES AN ASSIGNMENT, NOT ITS MEANING
==============================================

An assignment changes holders without changing its grant identity,
selected children or issuance history.

Moving it consumes all of the sender's aliases of that assignment.
Forms already obtained through those aliases are revoked immediately.
The sender's other capabilities remain usable.

A different generation is a different assignment. Its document is
neither consumed nor made authoritative by this transfer.

Staff authority additionally depends on relationships between holders.
Copying a staff title can preserve the delegated subtree.
Without that title, the lower documents remain unchanged but inactive.

The following two scenarios differ in exactly that choice.
*/

function transferPreservesIdentity(tw) {
	return transferDepartment(tw, true);
}

function staffAuthorityDependsOnTransferredRelationships(tw) {
	return transferDepartment(tw, false);
}


/*
Before:

    founder [root, department, alias, stale, knownStaff]
       |
       +-- staff [item] -- leaf [detail]

After:

    founder [root, stale, knownStaff, replacement]
       |
       +-- replacement [department, optionally staff]
       |
       +-- staff [item] -- leaf [detail]

The founder retains its copied staff title. That relationship alone
is no longer sufficient: the department's new holder must have its
own direct relationship to staff.

The staff and leaf tiddlers are never rewritten by the transfer.
*/

function transferDepartment(tw, includeStaffTitle) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = "$:/clerus/jobs/spec-transfer-founder";
	var recipient = source + "/replacement";
	var staff = "$:/clerus/jobs/spec-transfer-staff";
	var leaf = "$:/clerus/jobs/spec-transfer-leaf";
	var project = "Architectural Transfer Project";

	function grant(role, link, issued, children) {
		return {
			form: "mission",
			project: project,
			role: role,
			link: link,
			issued: issued,
			children: children || {}
		};
	}

	var department = grant(
		["department"],
		"11",
		"7",
		{ item: "12" }
	);
	var stale = grant(["department"], "9", "0");

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

	function registry(title) {
		var tiddler = wiki.getTiddler(title);

		return tiddler ? JSON.parse(tiddler.fields.text) : null;
	}

	function captured(title) {
		return JSON.stringify(effects.capture(wiki.getTiddler(title)));
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
						item: {
							task: { name: "item" },
							parts: {
								detail: {
									task: { name: "detail" },
									parts: {}
								}
							}
						}
					}
				}
			}
		})
	}));

	addJob(source, "spec-transfer-founder", {
		root: grant([], "10", "0", { department: "11" }),
		department: department,
		alias: clone(department),
		stale: stale,
		knownStaff: staff,
		mandate: {
			form: "contract",
			temp: false,
			executor: "spec-transfer-recipient",
			book: { instruction: "Take over the department" }
		}
	});

	addJob(staff, "spec-transfer-employee", {
		mission: grant(
			["department", "item"],
			"12",
			"0",
			{ detail: "13" }
		),
		subordinate: leaf,
		note: { form: "memo", data: "staff evidence" }
	});

	addJob(leaf, "spec-transfer-employee", {
		mission: grant(["department", "item", "detail"], "13", "0"),
		note: { form: "memo", data: "leaf evidence" }
	});

	var staffBefore = captured(staff);
	var leafBefore = captured(leaf);
	var projectBefore = captured(project);

	var formsRevoked = false;
	var birthDeferred = false;
	var establishingOrders = 0;
	var prematureReady = 0;

	function founder(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		var assignment = operational.get("department");
		var alias = operational.get("alias");

		var replacement = operational.get("charter").createTitle(
			"replacement",
			"replacement"
		);

		replacement.order(
			"mandate",
			"department",
			includeStaffTitle ? { staff: "knownStaff" } : {}
		);

		birthDeferred = !wiki.tiddlerExists(recipient);

		// Transfer revokes both forms before this context closes.
		assertThrows(function () {
			assignment.inspect();
		}, "no longer");

		assertThrows(function () {
			alias.inspect();
		}, "no longer");

		formsRevoked = true;

		assert(
			!operational.get("stale").inspect().active,
			"Transfer activated another generation"
		);

		// Revoking transferred forms does not revoke the source writer.
		operational.get("charter").setStatus({
			phase: "transferred"
		});
	}

	function replacement(event, operational) {
		if (event.type === "ready") {
			prematureReady++;
			return;
		}

		if (event.type !== "order") {
			return;
		}

		establishingOrders++;

		assert(
			operational.get("mission").task().name === "department",
			"The new holder cannot read its assigned task"
		);

		assert(
			operational.get("charter").book().instruction ===
				"Take over the department",
			"Establishment lost the contract's instruction"
		);

		assert(
			(operational.keys().indexOf("staff") !== -1) ===
				includeStaffTitle,
			"The recipient received the wrong set of title references"
		);

		operational.get("charter").setStatus({
			phase: "active"
		});
	}

	function employee() {}

	var environment = specificationEnvironment(tw, {
		wiki: wiki,
		platform: platform,
		executors: {
			"spec-transfer-founder": founder,
			"spec-transfer-recipient": replacement,
			"spec-transfer-employee": employee
		}
	});

	var runtime = environment.runtime;
	var dispatcher = environment.dispatcher;

	function authority(title) {
		return missions.read(
			wiki,
			runtime.inspect().jobs,
			title,
			registry(title).mission
		);
	}

	runtime.start();

	try {
		assert(
			authority(staff).active && authority(leaf).active,
			"The initial staffed department is not active"
		);

		dispatcher.start();

		assert(
			dispatcher.inspect().errors.length === 0,
			"Transfer failed: " +
				JSON.stringify(dispatcher.inspect().errors)
		);

		var child = wiki.getTiddler(recipient);

		assert(
			child,
			"The synchronous dispatch pass did not materialize the recipient"
		);

		var parent = registry(source);
		var received = registry(recipient);

		assert(
			received.charter.status.phase === "active" &&
				!child.fields["clerus-start"],
			"The synchronous dispatch pass returned before establishment completed"
		);

		var unfinishedFlows = [];

		wiki.each(function (tiddler, title) {
			if (tiddler.fields["clerus-wal-kind"] === "flow") {
				unfinishedFlows.push(title);
			}
		});

		assert(
			unfinishedFlows.length === 0,
			"The synchronous dispatch pass left unfinished official flows: " +
				JSON.stringify(unfinishedFlows)
		);

		assert(formsRevoked, "Transferred forms remained usable");
		assert(birthDeferred, "Appointment escaped the persistent plan");

		assert(
			establishingOrders === 1 && prematureReady === 0,
			"The recipient was not established by exactly one order"
		);

		assert(
			!parent.department && !parent.alias && !parent.mandate,
			"The sender retained consumed documents"
		);

		assert(
			parent.root.role.length === 0 &&
				parent.charter.status.phase === "transferred",
			"Transfer disabled the sender's remaining capabilities"
		);

		assert(
			sameJson(received.mission, department),
			"Transfer changed grant identity or issuance history"
		);

		assert(
			sameJson(parent.stale, stale),
			"Transfer consumed or changed another generation"
		);

		assert(
			parent.knownStaff === staff,
			"Copying a title consumed the source's reference"
		);

		if (includeStaffTitle) {
			assert(
				received.staff === staff,
				"The selected staff title was not copied"
			);
		} else {
			assert(
				!received.staff,
				"An unselected staff title reached the recipient"
			);
		}

		assert(
			authority(staff).active === includeStaffTitle &&
				authority(leaf).active === includeStaffTitle,
			"Staff authority did not follow the new holder's relationships"
		);

		assert(
			captured(staff) === staffBefore &&
				captured(leaf) === leafBefore,
			"Transfer rewrote subordinate evidence"
		);

		assert(
			captured(project) === projectBefore,
			"Moving an assignment changed its project"
		);

		assert(
			runtime.inspect().missions.valid &&
				runtime.inspect().hierarchy.valid,
			"Transfer produced an invalid organization"
		);
	} finally {
		environment.stop();
	}
}


/*
Birth is not ordinary activation.

The founder proposes an appointment. After materialization, the
recipient already has the charter derived from the contract, but
still needs to complete its establishing order.
*/

function establishmentPrecedesOrdinaryActivation(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var founderTitle = "$:/clerus/jobs/spec-establishment";
	var workerTitle = founderTitle + "/worker";

	var birthDeferred = false;
	var readyCount = 0;
	var orderCount = 0;
	var orderId;

	wiki.addTiddler(new tw.Tiddler({
		title: founderTitle,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "spec-establishment-founder",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			mandate: {
				form: "contract",
				temp: false,
				executor: "spec-establishment-worker",
				book: { instruction: "Initialize before ordinary work" }
			}
		})
	}));

	function founder(event, operational) {
		if (event.type !== "ready") {
			return;
		}

		operational.get("charter")
			.createTitle("worker", "worker")
			.order("mandate");

		birthDeferred = !wiki.tiddlerExists(workerTitle);
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

		assert(
			operational.get("charter").book().instruction ===
				"Initialize before ordinary work",
			"Establishment did not transform the contract into a charter"
		);

		assert(
			wiki.getTiddler(workerTitle).fields["clerus-start"],
			"The newborn was acknowledged before initialization"
		);

		operational.get("charter").setStatus({
			phase: "initialized"
		});
	}

	var environment = specificationEnvironment(tw, {
		wiki: wiki,
		platform: platform,
		executors: {
			"spec-establishment-founder": founder,
			"spec-establishment-worker": worker
		}
	});

	var dispatcher = environment.dispatcher;

	try {
		environment.start();

		assert(
			dispatcher.inspect().errors.length === 0,
			"Establishment failed: " +
				JSON.stringify(dispatcher.inspect().errors)
		);

		var child = wiki.getTiddler(workerTitle);

		assert(
			child,
			"The synchronous dispatch pass did not materialize the newborn"
		);

		assert(
			!child.fields["clerus-start"],
			"The synchronous dispatch pass returned before establishment completed"
		);

		var parentRegistry = JSON.parse(
			wiki.getTiddler(founderTitle).fields.text
		);
		var childRegistry = JSON.parse(child.fields.text);

		assert(
			birthDeferred && orderCount === 1 && readyCount === 0,
			"Birth or ordinary activation bypassed establishment"
		);

		assert(
			!parentRegistry.mandate &&
				parentRegistry.worker === workerTitle,
			"Appointment did not consume its contract and file its title"
		);

		assert(
			orderId === child.fields["clerus-instance"] + "-order" &&
				childRegistry.charter.status.phase === "initialized",
			"Initialization lost its birth identity or committed result"
		);

		var unfinishedFlows = [];

		wiki.each(function (tiddler, title) {
			if (tiddler.fields["clerus-wal-kind"] === "flow") {
				unfinishedFlows.push(title);
			}
		});

		assert(
			unfinishedFlows.length === 0,
			"The synchronous dispatch pass left unfinished official flows: " +
				JSON.stringify(unfinishedFlows)
		);
	} finally {
		environment.stop();
	}
}


/*
6. TWO EXECUTION MODES, TWO FAILURE CONTRACTS
============================================

Ephemeral reactions materialize effects as they happen.
Failure cannot retract effects that are already visible.

Persistent reactions instead operate on an isolated proposal.
Executor failure discards that proposal before materialization.

The different failure transitions reflect these different contracts:
ephemeral dismissal and persistent suspension are not synonyms.
*/

function ephemeralFailureDoesNotUndoMaterializedWork(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title =
		"$:/temp/clerus/jobs/" + platform + "/spec-immediate-work";

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "spec-immediate-work",
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

	var immediateWriteObserved = false;
	var dismissed = false;
	var writeRefused = false;

	function registry() {
		return JSON.parse(wiki.getTiddler(title).fields.text);
	}

	function react(event, operational) {
		if (event.type === "ready") {
			operational.get("note").setData({ value: 1 });

			immediateWriteObserved = registry().note.data.value === 1;

			throw new Error("Ephemeral reaction failed after a write");
		}

		if (event.type !== "dismissed") {
			return;
		}

		dismissed = true;

		try {
			operational.get("note").setData({ value: 99 });
		} catch (error) {
			writeRefused =
				String(error.message).indexOf("read-only") !== -1;
		}
	}

	var environment = specificationEnvironment(tw, {
		wiki: wiki,
		platform: platform,
		executors: {
			"spec-immediate-work": react
		}
	});

	try {
		environment.start();

		assert(
			immediateWriteObserved && registry().note.data.value === 1,
			"Ephemeral failure undid already materialized work"
		);

		assert(
			dismissed &&
				writeRefused &&
				wiki.getTiddler(title).fields["clerus-custody"] === "user" &&
				registry().charter.status.phase === "dismissed",
			"Ephemeral failure did not end write authority"
		);

		var errors = environment.dispatcher.inspect().errors;

		assert(
			errors.length === 1 &&
				errors[0].message ===
					"Ephemeral reaction failed after a write",
			"The ephemeral failure lost its diagnostic"
		);
	} finally {
		environment.stop();
	}
}


/*
One persistent owner, one external target, one narrow warrant.

This fixture supplies the machinery, not the outcome. Each scenario
chooses the reaction and, where necessary, the point of interruption.
*/

function persistentWriteFixture(tw, react) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/spec-proposed-work";
	var target = "Architectural Proposed Work";

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		text: "Initial"
	}));

	var mission = {
		form: "mission",
		project: "Architectural Proposal Project",
		role: [],
		link: "10",
		issued: "0",
		children: {}
	};

	wiki.addTiddler(new tw.Tiddler({
		title: mission.project,
		type: "application/json",
		"clerus-custody": "user",
		text: JSON.stringify({
			task: { name: "Persistent work" },
			parts: {}
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "spec-proposed-work",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			note: {
				form: "memo",
				data: { value: 0 }
			},
			document: target,
			mission: mission,
			permission: {
				form: "warrant",
				filter: "[title[Architectural Proposed Work]]",
				operations: ["patch"],
				fields: ["text"]
			}
		})
	}));

	var fixture = {
		wiki: wiki,
		platform: platform,
		owner: owner,
		target: target
	};

	fixture.registry = function () {
		return JSON.parse(wiki.getTiddler(owner).fields.text);
	};

	fixture.open = function () {
		return specificationEnvironment(tw, {
			wiki: wiki,
			platform: platform,
			documents: [warrantDocument],
			executors: {
				"spec-proposed-work": react
			}
		});
	};

	return fixture;
}


function reactionsProposeIsolatedWork(tw) {
	proposal(false);
	proposal(true);

	function proposal(fail) {
		var observedIsolation = false;
		var savedMemo;

		var fixture = persistentWriteFixture(tw, function (
			event, operational
		) {
			if (event.type !== "ready") {
				return;
			}

			var document = operational.get("document");
			var memo = operational.get("note");

			document.patch("permission", {
				set: { text: "First" }
			});

			document.patch("permission", {
				set: { text: "Proposed" }
			});

			memo.setData({ value: 1 });

			assert(
				document.text() === "Proposed" &&
					memo.data().value === 1,
				"The reaction did not read its own writes"
			);

			assert(
				fixture.wiki.getTiddler(fixture.target).fields.text ===
					"Initial" &&
				fixture.registry().note.data.value === 0 &&
				fixture.registry().charter.status.phase === "initial",
				"Proposed work escaped into materialized state"
			);

			observedIsolation = true;
			savedMemo = memo;

			if (fail) {
				throw new Error("The executor rejects its proposal");
			}

			operational.get("charter").setStatus({
				phase: "complete"
			});
		});

		var environment = fixture.open();
		var dispatcher = environment.dispatcher;
		var missionBefore = JSON.stringify(fixture.registry().mission);

		try {
			environment.start();

			assert(
				observedIsolation,
				"The reaction did not demonstrate isolation"
			);

			assertThrows(function () {
				savedMemo.data();
			}, "closed");

			var registry = fixture.registry();
			var targetText =
				fixture.wiki.getTiddler(fixture.target).fields.text;
			var errors = dispatcher.inspect().errors;

			assert(
				JSON.stringify(registry.mission) === missionBefore,
				"The reaction or its failure transition changed the assignment"
			);

			if (fail) {
				assert(
					targetText === "Initial" &&
						registry.note.data.value === 0,
					"A rejected proposal published its changes"
				);

				assert(
					registry.charter.status.phase === "suspended" &&
					registry.charter.status.previous.phase === "initial",
					"Suspension included uncommitted proposal state"
				);

				assert(
					errors.length === 1 &&
						errors[0].phase === "reaction",
					"Executor failure was not classified as reaction failure"
				);
			} else {
				assert(
					targetText === "Proposed" &&
						registry.note.data.value === 1 &&
						registry.charter.status.phase === "complete",
					"The completed proposal was not materialized"
				);

				assert(
					errors.length === 0,
					"Successful work produced an executor error"
				);
			}
		} finally {
			environment.stop();
		}
	}
}


/*
Returning a Promise does not extend a reaction's lifetime.

The dispatcher rejects the proposal synchronously and closes its
capabilities. JavaScript may still execute the Promise continuation,
but that continuation cannot use the expired document forms.
*/

async function executorsCannotReturnAsynchronousContinuations(tw) {
	var continuation;
	var continuationRan = false;
	var lateReadError = null;
	var lateWriteError = null;
	var savedMemo;

	var fixture = persistentWriteFixture(tw, function (
		event, operational
	) {
		if (event.type !== "ready") {
			return;
		}

		savedMemo = operational.get("note");

		savedMemo.setData({ value: 1 });

		operational.get("document").patch("permission", {
			set: { text: "Rejected asynchronous proposal" }
		});

		continuation = Promise.resolve().then(function () {
			continuationRan = true;

			try {
				savedMemo.data();
			} catch (error) {
				lateReadError = error;
			}

			try {
				savedMemo.setData({ value: 2 });
			} catch (error) {
				lateWriteError = error;
			}
		});

		return continuation;
	});

	var environment = fixture.open();

	try {
		environment.start();

		assert(
			!continuationRan,
			"The Promise continuation ran inside the synchronous dispatch pass"
		);

		var errors = environment.dispatcher.inspect().errors;

		assert(
			errors.length === 1 &&
				errors[0].phase === "reaction" &&
				errors[0].message ===
					"Executor reactions must be synchronous",
			"Returning a Promise was not rejected as a synchronous reaction failure: " +
				JSON.stringify(errors)
		);

		assert(
			fixture.registry().note.data.value === 0 &&
				fixture.wiki.getTiddler(fixture.target).fields.text ===
					"Initial",
			"The asynchronous executor published its rejected proposal"
		);

		assert(
			fixture.registry().charter.status.phase === "suspended" &&
				fixture.registry().charter.status.previous.phase ===
					"initial",
			"The asynchronous executor was not suspended from committed state"
		);

		assertThrows(function () {
			savedMemo.data();
		}, "closed");

		var ownerAfterFailure = JSON.stringify(
			effects.capture(fixture.wiki.getTiddler(fixture.owner))
		);
		var targetAfterFailure = JSON.stringify(
			effects.capture(fixture.wiki.getTiddler(fixture.target))
		);

		await continuation;

		assert(
			continuationRan,
			"The scenario did not exercise the late continuation"
		);

		assert(
			lateReadError &&
				String(lateReadError.message).indexOf("closed") !== -1 &&
				lateWriteError &&
				String(lateWriteError.message).indexOf("closed") !== -1,
			"The late continuation retained document capabilities"
		);

		assert(
			JSON.stringify(
				effects.capture(fixture.wiki.getTiddler(fixture.owner))
			) === ownerAfterFailure &&
				JSON.stringify(
					effects.capture(fixture.wiki.getTiddler(fixture.target))
				) === targetAfterFailure,
			"The late continuation changed materialized state"
		);
	} finally {
		environment.stop();
	}
}


/*
7. OFFICIAL MESSAGES FORM SYNCHRONOUS CAUSAL WAVES
================================================

Official messages have stable identities and document-transfer rules.
Their public events reveal only the addressing information required
by the protocol.

An order does not disclose its sender to the receiving executor.
A report identifies the project role from which the result is sent.

Official messages continue the current synchronous dispatch wave.
An upward report chain may turn into a downward order chain.
All available reactions and their local materialization complete
before the dispatch pass returns.

This causal continuity does not by itself make the entire wave
one transaction.

An executor cannot report while reacting to an order.
Deferral schedules an independent tick after that order flow ends.
Repeated requests coalesce into one tick.

Reports can then continue upward through one transactional flow.
A forwarding executor uses its own role signature.
A failed forwarding reaction publishes neither its proposed filing
nor its outgoing report.

Establishment is a protocol too: the contract becomes a charter,
and the newborn receives its establishing order before any ordinary
ready activation.
*/

function messagesHaveIdentityAndLimitedDisclosure(tw) {
	var platform = tw.browser ? "browser" : "node";
	var rules = documentFlow.loadRules(specificationModules({}));

	var source = {
		title: "$:/clerus/jobs/spec-message-source",
		executor: "source",
		platform: platform
	};

	var recipient = {
		title: "$:/clerus/jobs/spec-message-recipient",
		executor: "recipient",
		platform: platform
	};

	var documents = {
		note: {
			form: "memo",
			data: { answer: 42 }
		}
	};

	var order = messageEffects.create({
		id: "spec-order",
		message: "order",
		source: source,
		recipient: recipient,
		registry: documents
	}, rules);

	documents.note.data.answer = 99;

	assert(
		order.registry.note.data.answer === 42,
		"The official message retained mutable caller data"
	);

	var orderEvent = messageEffects.event(order);

	assert(
		orderEvent.type === "order" &&
			orderEvent.id === "spec-order" &&
			!("source" in orderEvent) &&
			!("role" in orderEvent),
		"The order lost identity or disclosed unnecessary addressing data"
	);

	var report = messageEffects.create({
		id: "spec-report",
		message: "report",
		source: source,
		recipient: recipient,
		project: "Architectural Message Project",
		role: ["department"],
		registry: {}
	}, rules);

	var reportEvent = messageEffects.event(report);

	assert(
		reportEvent.type === "report" &&
			reportEvent.id === "spec-report" &&
			reportEvent.project === "Architectural Message Project" &&
			reportEvent.role.join("/") === "department" &&
			!("source" in reportEvent),
		"The report did not expose precisely its role signature"
	);
}


/*
One initial activation produces an upward report chain and a
downward order chain.

The whole causal wave must finish before start() returns.
This does not require the whole wave to share one transaction.
*/

function officialMessagesCompleteWithinOneDispatchPass(tw) {
	var fixture = delegationFixture(tw);
	var wiki = fixture.wiki;
	var platform = tw.browser ? "browser" : "node";
	var trace = [];
	var readyCount = [0, 0, 0];

	fixture.jobs.forEach(function (job, index) {
		job.registry.charter = {
			form: "charter",
			status: { phase: "initial" }
		};

		job.registry.evidence = {
			form: "memo",
			data: { answer: 42 }
		};

		wiki.addTiddler(new tw.Tiddler({
			title: job.title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "spec-wave-" + index,
			text: JSON.stringify(job.registry)
		}));
	});

	function registry(job) {
		return JSON.parse(wiki.getTiddler(job.title).fields.text);
	}

	function director(event, operational, incoming) {
		if (event.type === "ready") {
			readyCount[0]++;
			return;
		}

		if (event.type !== "report") {
			return;
		}

		trace.push("director:report");

		assert(
			registry(fixture.manager).charter.status.phase === "forwarded",
			"The director ran before the forwarding state materialized"
		);

		incoming.get("result").file("result");

		operational.get("subordinate").order({
			instruction: "result"
		});

		assert(
			trace.join(",") ===
				"worker:ready,manager:report,director:report",
			"Ordering invoked a recipient before the director reaction completed"
		);

		operational.get("charter").setStatus({
			phase: "ordered"
		});
	}

	function manager(event, operational, incoming) {
		if (event.type === "ready") {
			readyCount[1]++;
			return;
		}

		if (event.type === "report") {
			trace.push("manager:report");

			assert(
				registry(fixture.worker).charter.status.phase === "reported",
				"The report recipient ran before the sender state materialized"
			);

			incoming.get("result").file("result");

			operational.get("mission").report({
				result: "result"
			});

			assert(
				trace.join(",") === "worker:ready,manager:report",
				"Forwarding invoked a recipient before the forwarding reaction completed"
			);

			operational.get("charter").setStatus({
				phase: "forwarded"
			});
			return;
		}

		if (event.type !== "order") {
			return;
		}

		trace.push("manager:order");

		assert(
			registry(fixture.director).charter.status.phase === "ordered",
			"The manager received an order before the director state materialized"
		);

		assert(
			operational.get("charter").status().phase === "forwarded",
			"The downward order did not observe the accepted report reaction"
		);

		incoming.get("instruction").file("instruction");

		operational.get("subordinate").order({
			instruction: "instruction"
		});

		assert(
			trace.join(",") ===
				"worker:ready,manager:report,director:report,manager:order",
			"Ordering invoked the worker before the manager reaction completed"
		);

		operational.get("charter").setStatus({
			phase: "ordered"
		});
	}

	function worker(event, operational, incoming) {
		if (event.type === "ready") {
			readyCount[2]++;
			trace.push("worker:ready");

			operational.get("mission").report({
				result: "evidence"
			});

			assert(
				trace.join(",") === "worker:ready",
				"Reporting invoked a recipient before the sender reaction completed"
			);

			operational.get("charter").setStatus({
				phase: "reported"
			});
			return;
		}

		if (event.type !== "order") {
			return;
		}

		trace.push("worker:order");

		assert(
			registry(fixture.manager).charter.status.phase === "ordered",
			"The worker received an order before the manager state materialized"
		);

		assert(
			operational.get("charter").status().phase === "reported",
			"The downward order did not observe the accepted initial reaction"
		);

		incoming.get("instruction").file("instruction");

		assert(
			operational.get("instruction").data().answer === 42,
			"The causal wave lost its document payload"
		);

		operational.get("charter").setStatus({
			phase: "complete"
		});
	}

	var environment = specificationEnvironment(tw, {
		wiki: wiki,
		platform: platform,
		executors: {
			"spec-wave-0": director,
			"spec-wave-1": manager,
			"spec-wave-2": worker
		}
	});

	try {
		environment.start();

		var inspection = environment.dispatcher.inspect();

		assert(
			inspection.errors.length === 0,
			"The official message wave failed: " +
				JSON.stringify(inspection.errors)
		);

		assert(
			trace.join(",") ===
				"worker:ready,manager:report,director:report," +
				"manager:order,worker:order",
			"The dispatch pass returned before completing its causal wave: " +
				JSON.stringify(trace)
		);

		assert(
			readyCount.join(",") === "1,1,1",
			"Official messages caused duplicate ordinary activation"
		);

		assert(
			registry(fixture.director).charter.status.phase === "ordered" &&
				registry(fixture.manager).charter.status.phase === "ordered" &&
				registry(fixture.worker).charter.status.phase === "complete",
			"The dispatch pass returned before materializing the whole wave"
		);

		assert(
			inspection.pendingFlowMessages === 0,
			"The dispatch pass left official messages awaiting delivery"
		);

		var unfinishedFlows = [];

		wiki.each(function (tiddler, title) {
			if (tiddler.fields["clerus-wal-kind"] === "flow") {
				unfinishedFlows.push(title);
			}
		});

		assert(
			unfinishedFlows.length === 0,
			"The dispatch pass left unfinished official flows: " +
				JSON.stringify(unfinishedFlows)
		);
	} finally {
		environment.stop();
	}
}


/*
Draining a synchronous wave does not require an unavailable
recipient to become available.

A pending official message remains an obligation. Scanning must
return without dropping it or repeatedly attempting its delivery.
*/

function unavailableRecipientsPreservePendingMessages(tw) {
	var fixture = delegationFixture(tw);
	var wiki = fixture.wiki;
	var platform = tw.browser ? "browser" : "node";
	var managerReports = 0;

	fixture.jobs.forEach(function (job, index) {
		job.registry.charter = {
			form: "charter",
			status: { phase: "initial" }
		};

		wiki.addTiddler(new tw.Tiddler({
			title: job.title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "spec-unavailable-" + index,
			text: JSON.stringify(job.registry)
		}));
	});

	var source = fixture.worker;
	var recipient = fixture.manager;

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	var message = messageEffects.create({
		id: "architectural-unavailable-report",
		message: "report",
		source: {
			title: source.title,
			executor: "spec-unavailable-2",
			platform: platform
		},
		recipient: {
			title: recipient.title,
			executor: "spec-unavailable-1",
			platform: platform
		},
		project: source.registry.mission.project,
		role: source.registry.mission.role,
		registry: {
			result: { form: "memo", data: { answer: 42 } }
		}
	}, documentFlow.loadRules(specificationModules({})));

	plan.send(message);

	var flow = new FlowWal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () {
			return "architectural-unavailable-recipient";
		}
	});

	var journalTitle;

	try {
		journalTitle = flow.register({
			title: source.title,
			executor: "spec-unavailable-2",
			persistent: true
		}, plan.initial(source.title), plan.export());

		flow.resume(journalTitle);
	} finally {
		plan.abort();
	}

	// The message is already pending before recipient availability changes.
	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(recipient.title),
		{ "clerus-custody": "user" }
	));

	var recipientBefore = JSON.stringify(
		effects.capture(wiki.getTiddler(recipient.title))
	);
	var journalBefore = wiki.getTiddler(journalTitle).fields.text;

	function idle() {}

	function manager(event, operational, incoming) {
		if (event.type !== "report") {
			return;
		}

		managerReports++;

		assert(
			event.id === message.id,
			"Resumed delivery changed the pending message identity"
		);

		incoming.get("result").file("result");

		operational.get("charter").setStatus({
			phase: "received"
		});
	}

	var environment = specificationEnvironment(tw, {
		wiki: wiki,
		platform: platform,
		executors: {
			"spec-unavailable-0": idle,
			"spec-unavailable-1": manager,
			"spec-unavailable-2": idle
		}
	});

	function assertPending() {
		var inspection = environment.dispatcher.inspect();
		var pending = flow.pending(journalTitle);

		assert(
			managerReports === 0,
			"The unavailable recipient received the report"
		);

		assert(
			inspection.errors.length === 0,
			"Recipient unavailability became an executor failure: " +
				JSON.stringify(inspection.errors)
		);

		assert(
			inspection.pendingFlowMessages === 1 &&
				pending.length === 1 &&
				pending[0].id === message.id,
			"The dispatch pass lost the pending official message"
		);

		assert(
			JSON.stringify(
				effects.capture(wiki.getTiddler(recipient.title))
			) === recipientBefore &&
				wiki.getTiddler(journalTitle).fields.text === journalBefore,
			"Scanning rewrote the unavailable recipient or pending obligation"
		);
	}

	try {
		environment.start();
		assertPending();

		environment.dispatcher.scan();
		assertPending();

		// Restoring recipient custody permits delivery of the existing
		// obligation, not creation of a replacement message.
		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(recipient.title),
			{ "clerus-custody": platform }
		));

		environment.dispatcher.scan();

		var received = JSON.parse(
			wiki.getTiddler(recipient.title).fields.text
		);
		var inspection = environment.dispatcher.inspect();

		assert(
			managerReports === 1 &&
				received.result.data.answer === 42 &&
				received.charter.status.phase === "received",
			"The synchronous dispatch pass did not complete resumed delivery"
		);

		assert(
			inspection.errors.length === 0 &&
				inspection.pendingFlowMessages === 0 &&
				!wiki.tiddlerExists(journalTitle),
			"Resumed delivery did not close the pending obligation cleanly"
		);

		var recipientAfterDelivery = JSON.stringify(
			effects.capture(wiki.getTiddler(recipient.title))
		);

		environment.dispatcher.scan();

		assert(
			managerReports === 1 &&
				JSON.stringify(
					effects.capture(wiki.getTiddler(recipient.title))
				) === recipientAfterDelivery &&
				environment.dispatcher.inspect().pendingFlowMessages === 0 &&
				!wiki.tiddlerExists(journalTitle),
			"A subsequent dispatch pass repeated completed delivery"
		);
	} finally {
		environment.stop();
	}
}


/*
An order travels down the delegation chain.
The worker cannot turn its order reaction into an immediate report.

    director → manager → worker
                            |
                           defer
                            |
                           tick → manager → director

Memo evidence is copied. It is explicitly filed by each recipient.
Forwarding uses the manager's role, not the worker's signature.
*/

async function reportingHasAnExplicitCausalBoundary(tw) {
	await reporting(false);
	await reporting(true);

	async function reporting(failForwarding) {
		var fixture = delegationFixture(tw);
		var wiki = fixture.wiki;
		var platform = tw.browser ? "browser" : "node";

		var director = fixture.director;
		var manager = fixture.manager;
		var worker = fixture.worker;
		var project = director.registry.mission.project;

		director.registry.instruction = {
			form: "memo",
			data: { action: "report" }
		};

		worker.registry.evidence = {
			form: "memo",
			data: { answer: 42 }
		};

		fixture.jobs.forEach(function (job, index) {
			job.registry.charter = {
				form: "charter",
				status: { phase: "initial" }
			};

			wiki.addTiddler(new tw.Tiddler({
				title: job.title,
				type: "application/json",
				"clerus-custody": platform,
				"clerus-executor": "spec-report-" + index,
				text: JSON.stringify(job.registry)
			}));
		});

		function registry(job) {
			return JSON.parse(wiki.getTiddler(job.title).fields.text);
		}

		function flowTitles() {
			var titles = [];

			wiki.each(function (tiddler, title) {
				if (tiddler.fields["clerus-wal-kind"] === "flow") {
					titles.push(title);
				}
			});

			return titles.sort();
		}

		var orderReportRefused = false;
		var tickCount = 0;
		var managerReports = 0;
		var directorReports = 0;
		var reportFlows = [];
		var savedIncoming;

		function observeReport(event, expectedRole) {
			assert(
				event.id &&
					event.project === project &&
					event.role.join("/") === expectedRole &&
					!("source" in event),
				"A report lost its identity or role signature"
			);

			var flows = flowTitles();

			assert(
				flows.length === 1,
				"A report did not execute within one official flow"
			);

			reportFlows.push(flows[0]);
		}

		function directorReact(event, operational, incoming) {
			if (event.type === "ready") {
				operational.get("subordinate").order({
					instruction: "instruction"
				});
				return;
			}

			if (event.type !== "report") {
				return;
			}

			directorReports++;
			observeReport(event, "department");

			incoming.get("result").file("finalResult");

			operational.get("charter").setStatus({
				phase: "complete"
			});
		}

		function managerReact(event, operational, incoming) {
			if (event.type === "order") {
				incoming.get("instruction").file("instruction");

				operational.get("subordinate").order({
					instruction: "instruction"
				});
				return;
			}

			if (event.type !== "report") {
				return;
			}

			managerReports++;
			observeReport(event, "department/item");

			savedIncoming = incoming.get("result");
			savedIncoming.file("workerResult");

			operational.get("mission").report({
				result: "workerResult"
			});

			if (failForwarding) {
				throw new Error("Forwarding proposal rejected");
			}

			operational.get("charter").setStatus({
				phase: "forwarded"
			});
		}

		function workerReact(event, operational) {
			if (event.type === "order") {
				var before = wiki.getTiddler(worker.title).fields.text;

				assertThrows(function () {
					operational.get("mission").report({
						result: "evidence"
					});
				}, "Cannot report while reacting to an order");

				assert(
					wiki.getTiddler(worker.title).fields.text === before,
					"The refused report changed materialized state"
				);

				orderReportRefused = true;

				operational.get("charter").defer();
				operational.get("charter").defer();
				return;
			}

			if (event.type !== "tick") {
				return;
			}

			tickCount++;

			assert(event.id, "The independent tick has no identity");

			assert(
				flowTitles().length === 0,
				"The tick continued the original order flow"
			);

			operational.get("mission").report({
				result: "evidence"
			});

			assert(
				operational.get("mission").inspect().readable,
				"Memo reporting consumed the addressing assignment"
			);

			operational.get("charter").setStatus({
				phase: "reported"
			});
		}

		var environment = specificationEnvironment(tw, {
			wiki: wiki,
			platform: platform,
			executors: {
				"spec-report-0": directorReact,
				"spec-report-1": managerReact,
				"spec-report-2": workerReact
			}
		});

		var dispatcher = environment.dispatcher;
		var originalScan = dispatcher.scan;
		var completedTickPasses = 0;
		var tickPassError = null;

		dispatcher.scan = function () {
			var ticksBefore = tickCount;
			var result = originalScan.apply(this, arguments);

			if (tickCount !== ticksBefore) {
				completedTickPasses++;

				try {
					assert(
						tickCount === ticksBefore + 1,
						"One dispatch pass delivered duplicate deferred ticks"
					);

					assert(
						managerReports === 1,
						"The tick dispatch pass returned before delivering the worker report"
					);

					if (failForwarding) {
						assert(
							directorReports === 0 &&
								!registry(manager).workerResult &&
								!registry(director).finalResult &&
								wiki.getTiddler(manager.title)
									.fields["clerus-custody"] === "user",
							"The tick dispatch pass returned before completing the forwarding failure"
						);
					} else {
						assert(
							directorReports === 1 &&
								registry(director).charter.status.phase ===
									"complete" &&
								flowTitles().length === 0,
							"The tick dispatch pass returned before completing the report wave"
						);
					}
				} catch (error) {
					tickPassError = error;
				}
			}

			return result;
		};

		try {
			environment.start();

			await waitFor(function () {
				var errors = dispatcher.inspect().errors;

				if (completedTickPasses > 0) {
					return true;
				}

				assert(
					errors.length === 0,
					"Reporting failed before the deferred tick pass completed: " +
						JSON.stringify(errors)
				);

				return false;
			}, 2000, "the independent tick and its synchronous report wave");

			if (tickPassError) {
				throw tickPassError;
			}

			assert(
				completedTickPasses === 1,
				"The deferred tick did not complete in one dispatch pass"
			);

			assert(
				orderReportRefused &&
					tickCount === 1 &&
					managerReports === 1,
				"The order/report boundary or deferred coalescing failed"
			);

			assertThrows(function () {
				savedIncoming.data();
			}, "closed");

			if (failForwarding) {
				assert(
					directorReports === 0 &&
						!registry(manager).workerResult &&
						!registry(director).finalResult,
					"A failed forwarding proposal published its effects"
				);

				var errors = dispatcher.inspect().errors;

				assert(
					errors.length === 1 &&
						errors[0].title === manager.title &&
						errors[0].message === "Forwarding proposal rejected",
					"The forwarding failure lost its diagnostic"
				);
			} else {
				assert(
					directorReports === 1 &&
						registry(manager).workerResult.data.answer === 42 &&
						registry(director).finalResult.data.answer === 42,
					"The report chain lost or duplicated its result"
				);

				assert(
					reportFlows.length === 2 &&
						reportFlows[0] === reportFlows[1],
					"Upward forwarding did not share one flow"
				);

				assert(
					flowTitles().length === 0 &&
						dispatcher.inspect().errors.length === 0,
					"The completed report flow did not close cleanly"
				);
			}

			assert(
				registry(worker).evidence.data.answer === 42 &&
					registry(worker).charter.status.phase === "reported",
				"Reporting lost the sender's evidence or committed work"
			);

			assert(
				registry(director).mission &&
					registry(manager).mission &&
					registry(worker).mission,
				"Memo reporting transferred an assignment"
			);
		} finally {
			environment.stop();
			dispatcher.scan = originalScan;
		}
	}
}


/*
8. ACCEPTED OBLIGATIONS SURVIVE INTERRUPTION
============================================

Executor failure discards an unaccepted proposal.
Acceptance creates a different obligation.

Acceptance completes authorization of the proposed operation.
Recovery does not authorize it again as a new executor action.

It must still respect the recorded materialization preconditions.
Revoking a separate upper grant does not cancel accepted work,
but changed owner or target state can prevent its completion.

An infrastructure failure during materialization must not be
treated as an executor failure. The accepted plan survives, and
unfinished materialization blocks further execution.

Recovery finishes the accepted work; it does not rerun the reaction
to reconstruct an intention that has already been accepted.

A paused obligation requires explicit authorization to continue.
*/

function acceptedWorkSurvivesInfrastructureFailure(tw) {
	var readyCount = 0;
	var suspendedCount = 0;

	var fixture = persistentWriteFixture(tw, function (
		event, operational
	) {
		if (event.type === "suspended") {
			suspendedCount++;
			return;
		}

		if (event.type !== "ready") {
			return;
		}

		readyCount++;

		// After recovery, activation observes the completed obligation.
		if (operational.get("charter").status().phase !== "initial") {
			return;
		}

		// The external effect precedes the owner effect.
		operational.get("document").patch("permission", {
			set: { text: "Accepted" }
		});

		operational.get("charter").setStatus({
			phase: "complete"
		});
	});

	var wiki = fixture.wiki;
	var ownerBefore = JSON.stringify(
		effects.capture(wiki.getTiddler(fixture.owner))
	);

	var originalAdd = wiki.addTiddler.bind(wiki);
	var interrupted = false;

	wiki.addTiddler = function (tiddler) {
		var result = originalAdd(tiddler);

		if (
			!interrupted &&
			tiddler.fields.title === fixture.target &&
			tiddler.fields.text === "Accepted"
		) {
			interrupted = true;
			throw new Error("Materialization interrupted after a write");
		}

		return result;
	};

	var environment = fixture.open();
	var dispatcher = environment.dispatcher;
	var journalTitle;
	var journalText;

	try {
		environment.start();

		assert(interrupted, "The materialization was not interrupted");

		assert(
			wiki.getTiddler(fixture.target).fields.text === "Accepted",
			"The interruption did not leave a partially applied result"
		);

		assert(
			JSON.stringify(
				effects.capture(wiki.getTiddler(fixture.owner))
			) === ownerBefore,
			"Infrastructure failure rewrote the owner"
		);

		assert(
			readyCount === 1 && suspendedCount === 0,
			"Infrastructure failure was treated as executor failure"
		);

		var blockers = dispatcher.materializationBlockers({
			title: fixture.owner,
			persistent: true
		});

		assert(
			blockers.length === 1,
			"The unfinished obligation did not block execution"
		);

		journalTitle = blockers[0];

		var journal = wiki.getTiddler(journalTitle);

		assert(
			journal &&
				journal.fields["clerus-custody"] === "user",
			"The interrupted obligation was not retained as paused work"
		);

		journalText = journal.fields.text;

		assert(
			dispatcher.inspect().errors.length === 1 &&
				dispatcher.inspect().errors[0].phase === "commit",
			"The materialization failure was misclassified"
		);

		dispatcher.scan();

		assert(
			readyCount === 1,
			"The blocked owner was reactivated"
		);
	} finally {
		wiki.addTiddler = originalAdd;
		environment.stop();
	}

	// A fresh runtime must respect the same persisted blocker.
	environment = fixture.open();

	try {
		environment.start();

		assert(
			readyCount === 1,
			"Restart bypassed the paused obligation"
		);

		var pausedJournal = wiki.getTiddler(journalTitle);

		assert(
			pausedJournal &&
				pausedJournal.fields["clerus-custody"] === "user" &&
				pausedJournal.fields.text === journalText,
			"Restart changed or discarded the paused obligation"
		);

		assert(
			environment.dispatcher.materializationBlockers({
				title: fixture.owner,
				persistent: true
			}).length === 1,
			"Restart lost the materialization blocker"
		);

		assert(
			JSON.stringify(
				effects.capture(wiki.getTiddler(fixture.owner))
			) === ownerBefore,
			"Restart changed the blocked owner"
		);
	} finally {
		environment.stop();
	}

	// Explicitly authorize completion of the accepted plan.
	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(journalTitle),
		{ "clerus-custody": fixture.platform }
	));

	environment = fixture.open();

	try {
		environment.start();

		assert(
			!wiki.tiddlerExists(journalTitle),
			"Recovery did not release the completed obligation"
		);

		assert(
			fixture.registry().charter.status.phase === "complete" &&
				wiki.getTiddler(fixture.target).fields.text === "Accepted",
			"Recovery did not finish the accepted result"
		);

		assert(
			readyCount === 2 && suspendedCount === 0,
			"Recovery did not restore ordinary activation"
		);

		assert(
			environment.dispatcher.inspect().errors.length === 0,
			"Successful recovery produced executor errors"
		);
	} finally {
		environment.stop();
	}
}


/*
Reconstruct only materialized tiddlers.

No runtime objects, pending promises, plan instances or executor
contexts cross this boundary.
*/

function restoredWiki(tw, wiki) {
	var restored = new tw.Wiki();

	wiki.each(function (tiddler) {
		restored.addTiddler(new tw.Tiddler(effects.capture(tiddler)));
	});

	return restored;
}


/*
Materialization is not a physically atomic multi-tiddler write.
An interruption can leave some accepted effects applied and others
pending.

Recovery uses the persisted obligation, not the executor's memory.
It recognizes completed effects and finishes the remaining work.

Acceptance does not grant an unconditional right to overwrite later
changes. If recorded preconditions no longer hold, recovery preserves
the conflicting state and pauses the obligation for intervention.
*/

function acceptedPlansRecoverFromPartialMaterialization(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/spec-recovery-owner";
	var target = "Architectural Recovery Target";

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "spec-recovery",
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

	plan.patch(target, { text: "Accepted" });
	plan.patch(owner, {
		text: JSON.stringify({
			charter: { form: "charter", status: "complete" }
		})
	});

	var flow = new FlowWal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () {
			return "architectural-recovery";
		}
	});

	var journalTitle = flow.register({
		title: owner,
		executor: "spec-recovery",
		persistent: true
	}, plan.initial(owner), plan.export());

	var originalAdd = wiki.addTiddler.bind(wiki);
	var interrupted = false;

	wiki.addTiddler = function (tiddler) {
		var result = originalAdd(tiddler);

		if (!interrupted && tiddler.fields.title === target) {
			interrupted = true;
			throw new Error("Interrupted after the external write");
		}

		return result;
	};

	try {
		assertThrows(function () {
			flow.resume(journalTitle);
		}, "Interrupted");

		assert(
			interrupted &&
				wiki.getTiddler(target).fields.text === "Accepted" &&
				JSON.parse(wiki.getTiddler(owner).fields.text)
					.charter.status === "initial",
			"The fixture did not stop between accepted effects"
		);

		assert(
			wiki.getTiddler(journalTitle)
				.fields["clerus-custody"] === "user",
			"The interrupted obligation was not paused"
		);
	} finally {
		wiki.addTiddler = originalAdd;
		plan.abort();
	}

	wiki = restoredWiki(tw, wiki);

	var restoredAdd = wiki.addTiddler.bind(wiki);
	var repeatedTargetWrites = 0;

	wiki.addTiddler = function (tiddler) {
		if (tiddler.fields.title === target) {
			repeatedTargetWrites++;
		}

		return restoredAdd(tiddler);
	};

	try {
		var recoveredFlow = new FlowWal({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform
		});

		assert(
			recoveredFlow.recover()[0].status === "paused",
			"Restoration silently authorized a paused obligation"
		);

		// Authorize continuation, not a new execution of the original work.
		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(journalTitle),
			{ "clerus-custody": platform }
		));

		var recovery = recoveredFlow.recover();

		assert(
			recovery[0].status === "closed" &&
				!wiki.tiddlerExists(journalTitle),
			"Recovery did not finish and release the obligation"
		);

		assert(
			wiki.getTiddler(target).fields.text === "Accepted" &&
				JSON.parse(wiki.getTiddler(owner).fields.text)
					.charter.status === "complete",
			"Recovery did not preserve the accepted result"
		);

		assert(
			repeatedTargetWrites === 0,
			"Recovery rewrote an already materialized effect"
		);
	} finally {
		wiki.addTiddler = restoredAdd;
	}
}


/*
An accepted obligation does not authorize overwriting later state.

The plan was valid when accepted. Before materialization, the human
changes its target without changing custody.

Recovery must detect the changed state, preserve both the human's
edit and the unfinished obligation, and stop for intervention.

Custody alone cannot make an obsolete precondition true.
*/

function recoveryDoesNotOverwriteIntervention(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/spec-conflicting-recovery";
	var target = "Architectural Recovery Conflict";

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "spec-conflicting-recovery",
		text: JSON.stringify({
			charter: { form: "charter", status: "initial" }
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		text: "Original"
	}));

	var ownerBefore = JSON.stringify(
		effects.capture(wiki.getTiddler(owner))
	);

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	plan.patch(target, {
		text: "Accepted executor result"
	});

	plan.patch(owner, {
		text: JSON.stringify({
			charter: { form: "charter", status: "complete" }
		})
	});

	var flow = new FlowWal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () {
			return "architectural-recovery-conflict";
		}
	});

	var journalTitle;

	try {
		journalTitle = flow.register({
			title: owner,
			executor: "spec-conflicting-recovery",
			persistent: true
		}, plan.initial(owner), plan.export());
	} finally {
		// The accepted serialized obligation must stand on its own.
		plan.abort();
	}

	// Human intervention changes content, not the custody marker.
	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(target),
		{ text: "Human revision" }
	));

	var intervention = JSON.stringify(
		effects.capture(wiki.getTiddler(target))
	);

	wiki = restoredWiki(tw, wiki);

	var recoveredFlow = new FlowWal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform
	});

	assertThrows(function () {
		recoveredFlow.resume(journalTitle);
	}, "precondition");

	assert(
		JSON.stringify(
			effects.capture(wiki.getTiddler(target))
		) === intervention,
		"Recovery overwrote the intervening revision"
	);

	assert(
		JSON.stringify(
			effects.capture(wiki.getTiddler(owner))
		) === ownerBefore,
		"Conflicting recovery published the owner's completion"
	);

	var journal = wiki.getTiddler(journalTitle);

	assert(
		journal &&
			journal.fields["clerus-custody"] === "user",
		"Conflicting recovery discarded or failed to pause the obligation"
	);

	assert(
		recoveredFlow.recover()[0].status === "paused",
		"The conflicting obligation was retried without authorization"
	);

	assert(
		JSON.stringify(
			effects.capture(wiki.getTiddler(target))
		) === intervention &&
			JSON.stringify(
				effects.capture(wiki.getTiddler(owner))
			) === ownerBefore,
		"Paused recovery changed materialized state"
	);
}


/*
Acceptance does not authorize recovery to reclaim a target.

Changing only custody is enough to invalidate the recorded
materialization precondition. Recovery preserves the target,
the owner's preceding state and the accepted obligation.
*/

function recoveryDoesNotReclaimTargetCustody(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/spec-recovery-custody";
	var target = "Architectural Recovery Custody";

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "spec-recovery-custody",
		text: JSON.stringify({
			charter: { form: "charter", status: "initial" }
		})
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		text: "Original"
	}));

	var ownerBefore = JSON.stringify(
		effects.capture(wiki.getTiddler(owner))
	);

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	// Put the owner effect first: preflight must detect the target
	// conflict before publishing even this otherwise valid effect.
	plan.patch(owner, {
		text: JSON.stringify({
			charter: { form: "charter", status: "complete" }
		})
	});

	plan.patch(target, {
		text: "Accepted executor result"
	});

	var flow = new FlowWal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () {
			return "architectural-recovery-custody";
		}
	});

	var journalTitle;

	try {
		journalTitle = flow.register({
			title: owner,
			executor: "spec-recovery-custody",
			persistent: true
		}, plan.initial(owner), plan.export());
	} finally {
		plan.abort();
	}

	var acceptedJournalText = wiki.getTiddler(journalTitle).fields.text;

	// Content remains unchanged; only responsibility for writing moves.
	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(target),
		{ "clerus-custody": "user" }
	));

	var targetAfterHandoff = JSON.stringify(
		effects.capture(wiki.getTiddler(target))
	);

	wiki = restoredWiki(tw, wiki);

	var recoveredFlow = new FlowWal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform
	});

	assertThrows(function () {
		recoveredFlow.resume(journalTitle);
	}, "precondition");

	assert(
		JSON.stringify(
			effects.capture(wiki.getTiddler(target))
		) === targetAfterHandoff,
		"Recovery reclaimed custody or changed the handed-off target"
	);

	assert(
		JSON.stringify(
			effects.capture(wiki.getTiddler(owner))
		) === ownerBefore,
		"Recovery published an earlier effect before detecting lost target custody"
	);

	var journal = wiki.getTiddler(journalTitle);

	assert(
		journal &&
			journal.fields["clerus-custody"] === "user" &&
			journal.fields.text === acceptedJournalText,
		"Recovery discarded or changed the accepted obligation"
	);

	var recovery = recoveredFlow.recover();

	assert(
		recovery.length === 1 &&
			recovery[0].status === "paused",
		"Recovery retried the obligation without explicit authorization"
	);

	assert(
		JSON.stringify(
			effects.capture(wiki.getTiddler(target))
		) === targetAfterHandoff &&
			JSON.stringify(
				effects.capture(wiki.getTiddler(owner))
			) === ownerBefore &&
			wiki.getTiddler(journalTitle).fields.text ===
				acceptedJournalText,
		"Paused recovery changed the target, owner or accepted obligation"
	);
}


/*
Acceptance completes authorization of the proposed operation.

Revoking an upper grant prevents new work, but does not cancel an
already accepted plan whose owner and target preconditions still
hold. Recovery materializes that plan without borrowing authority
for a new reaction.
*/

function acceptedWorkSurvivesUpperGrantRevocation(tw) {
	var fixture = delegationFixture(tw);
	var wiki = fixture.wiki;
	var platform = tw.browser ? "browser" : "node";
	var holder = fixture.manager;
	var target = "Architectural Accepted Mission Work";

	var permission = {
		form: "warrant",
		filter: "[title[Architectural Accepted Mission Work]]",
		operations: ["patch"],
		fields: ["text"],
		mission: {
			project: holder.registry.mission.project,
			role: ["department"],
			link: "11"
		}
	};

	holder.registry.charter = {
		form: "charter",
		status: "initial"
	};
	holder.registry.document = target;
	holder.registry.permission = permission;

	fixture.jobs.forEach(function (job) {
		job.valid = true;
		job.local = true;
		job.owned = true;
		job.custody = platform;
		job.executor = "spec-accepted-mission-work";

		wiki.addTiddler(new tw.Tiddler({
			title: job.title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": job.executor,
			text: JSON.stringify(job.registry)
		}));
	});

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		text: "Initial"
	}));

	var runtime = {
		wiki: wiki,
		platform: platform,
		inspect: function () {
			return { jobs: clone(fixture.jobs) };
		}
	};

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	var flow = new FlowWal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () {
			return "architectural-accepted-mission-work";
		}
	});

	var journalTitle;

	try {
		tiddlerWriter.write({
			runtime: runtime,
			Tiddler: tw.Tiddler,
			job: holder,
			state: operationStates.planned(plan),
			documentKey: "document",
			title: target,
			warrantKey: "permission",
			warrant: permission,
			operation: "patch",
			patch: {
				set: { text: "Accepted under the active grant" }
			}
		});

		var proposedRegistry = clone(holder.registry);
		proposedRegistry.charter.status = "complete";

		plan.patch(holder.title, {
			text: JSON.stringify(proposedRegistry)
		});

		journalTitle = flow.register({
			title: holder.title,
			executor: holder.executor,
			persistent: true
		}, plan.initial(holder.title), plan.export());
	} finally {
		plan.abort();
	}

	assert(
		wiki.getTiddler(target).fields.text === "Initial" &&
			JSON.parse(wiki.getTiddler(holder.title).fields.text)
				.charter.status === "initial",
		"Acceptance prematurely materialized the proposal"
	);

	// Change only the separate upper grant, not the accepted owner
	// or any target of its plan.
	delete fixture.director.registry.mission.children.department;

	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(fixture.director.title),
		{ text: JSON.stringify(fixture.director.registry) }
	));

	assert(
		!readAssignment(fixture, holder).active,
		"Revoking the upper selection left the holder active"
	);

	assertThrows(function () {
		warrantMission.authorize({
			runtime: runtime,
			state: operationStates.live(wiki, tw.Tiddler),
			job: holder,
			warrant: permission
		});
	}, "active mission");

	var revokedUpperState = JSON.stringify(
		effects.capture(wiki.getTiddler(fixture.director.title))
	);

	wiki = restoredWiki(tw, wiki);

	var recoveredFlow = new FlowWal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform
	});

	var recovery = recoveredFlow.recover();

	assert(
		recovery.length === 1 &&
			recovery[0].status === "closed" &&
			!wiki.tiddlerExists(journalTitle),
		"Upper grant revocation prevented completion of accepted work"
	);

	var completedRegistry = JSON.parse(
		wiki.getTiddler(holder.title).fields.text
	);

	assert(
		wiki.getTiddler(target).fields.text ===
			"Accepted under the active grant" &&
			completedRegistry.charter.status === "complete",
		"Recovery did not materialize the accepted result"
	);

	assert(
		JSON.stringify(
			effects.capture(wiki.getTiddler(fixture.director.title))
		) === revokedUpperState,
		"Recovery restored the revoked upper grant"
	);

	fixture.wiki = wiki;
	holder.registry = completedRegistry;

	assert(
		!readAssignment(fixture, holder).active,
		"Completing accepted work restored mission authority"
	);
}


/*
An accepted plan remains bound to its recorded owner.

Replacing the executor or handing the owner to the human does not
authorize recovery to continue under the preceding owner's identity.
Even an unchanged external target must remain untouched.
*/

function recoveryRequiresTheRecordedOwner(tw) {
	check("executor");
	check("custody");

	function check(intervention) {
		var wiki = new tw.Wiki();
		var platform = tw.browser ? "browser" : "node";
		var owner = "$:/clerus/jobs/spec-recovery-owner-" + intervention;
		var target = "Architectural Recovery Owner " + intervention;
		var executor = "spec-recovery-recorded-owner";

		wiki.addTiddler(new tw.Tiddler({
			title: owner,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify({
				charter: { form: "charter", status: "initial" }
			})
		}));

		wiki.addTiddler(new tw.Tiddler({
			title: target,
			"clerus-custody": platform,
			text: "Initial"
		}));

		var targetBefore = JSON.stringify(
			effects.capture(wiki.getTiddler(target))
		);

		var plan = new workPlans.WorkPlan({
			wiki: wiki,
			Wiki: tw.Wiki,
			Tiddler: tw.Tiddler
		});

		// An external effect comes first. Owner validation must prevent
		// it from being applied when the recorded owner is no longer eligible.
		plan.patch(target, {
			text: "Accepted result"
		});

		plan.patch(owner, {
			text: JSON.stringify({
				charter: { form: "charter", status: "complete" }
			})
		});

		var flow = new FlowWal({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			idFactory: function () {
				return "architectural-recorded-owner-" + intervention;
			}
		});

		var journalTitle;

		try {
			journalTitle = flow.register({
				title: owner,
				executor: executor,
				persistent: true
			}, plan.initial(owner), plan.export());
		} finally {
			plan.abort();
		}

		var acceptedJournalText =
			wiki.getTiddler(journalTitle).fields.text;

		var changes = intervention === "executor"
			? { "clerus-executor": "spec-recovery-replacement-owner" }
			: { "clerus-custody": "user" };

		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(owner),
			changes
		));

		var intervenedOwner = JSON.stringify(
			effects.capture(wiki.getTiddler(owner))
		);

		wiki = restoredWiki(tw, wiki);

		var recoveredFlow = new FlowWal({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform
		});

		assertThrows(function () {
			recoveredFlow.resume(journalTitle);
		}, "owner is no longer locally authorized");

		assert(
			JSON.stringify(
				effects.capture(wiki.getTiddler(target))
			) === targetBefore,
			"Recovery changed an external target after owner " +
				intervention + " intervention"
		);

		assert(
			JSON.stringify(
				effects.capture(wiki.getTiddler(owner))
			) === intervenedOwner,
			"Recovery overwrote owner " + intervention + " intervention"
		);

		var journal = wiki.getTiddler(journalTitle);

		assert(
			journal &&
				journal.fields["clerus-custody"] === "user" &&
				journal.fields.text === acceptedJournalText,
			"Recovery failed to preserve and pause the accepted obligation"
		);

		var recovery = recoveredFlow.recover();

		assert(
			recovery.length === 1 &&
				recovery[0].status === "paused",
			"Recovery retried work bound to the preceding owner"
		);

		assert(
			JSON.stringify(
				effects.capture(wiki.getTiddler(target))
			) === targetBefore &&
				JSON.stringify(
					effects.capture(wiki.getTiddler(owner))
				) === intervenedOwner &&
				wiki.getTiddler(journalTitle).fields.text ===
					acceptedJournalText,
			"Paused recovery changed the owner, target or obligation"
		);
	}
}


/*
9. EXTERNAL EFFECTS LIMIT WHAT RECOVERY CAN KNOW
===============================================

Local materialization can be resumed from an accepted plan.
An external request cannot necessarily be resumed or safely repeated.

The request is persisted before transport begins.
The response is persisted before notification reaches the executor.
A rejected proposal must never invoke transport.

After restart, a running request may already have reached the service.
Without a persisted outcome, recovery records uncertainty rather than
silently repeating the request.

Scheduling transport does not preserve permission to start it.
The driver must still be running, and the recorded operation must
still be current and locally authorized, when transport actually begins.

Stopping the driver before transport begins prevents the request.
Losing custody before transport begins has the same effect.

Once transport has begun, custody loss cannot undo the external
request. It does prevent a late response from changing the registry
or notifying its former owner.

These scenarios select architectural witnesses. The regression suite
retains the detailed response-continuation and interruption cases.
*/

function agentCallFixture(tw, options) {
	options = options || {};

	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/spec-external-operation";

	var fixture = {
		wiki: new tw.Wiki(),
		platform: platform,
		title: title,
		transports: 0,
		ticks: 0,
		submissionDeferred: false,
		transportSawRunning: false
	};

	fixture.registry = function () {
		return JSON.parse(
			fixture.wiki.getTiddler(title).fields.text
		);
	};

	fixture.wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "spec-external-operation",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			call: options.call || {
				form: "agent-call",
				id: "architectural-call",
				sequence: "0",
				phase: "idle"
			}
		})
	}));

	function react(event, operational) {
		if (
			event.type === "ready" &&
			operational.get("call").inspect().phase === "idle"
		) {
			operational.get("call").submit({
				prompt: "Return forty-two"
			});

			fixture.submissionDeferred =
				fixture.transports === 0 &&
				fixture.registry().call.phase === "idle";

			if (options.failAfterSubmit) {
				throw new Error("Proposal rejected after submit");
			}

			return;
		}

		if (event.type !== "tick") {
			return;
		}

		fixture.ticks++;

		var call = operational.get("call").inspect();
		var persisted = fixture.registry().call;

		assert(
			persisted.phase === call.phase,
			"The executor observed an unpersisted call outcome"
		);

		if (call.phase === "completed") {
			assert(
				persisted.response.answer === 42 &&
					call.response.answer === 42,
				"The persisted response was lost"
			);
		}

		operational.get("charter").setStatus({
			phase: call.phase
		});
	}

	fixture.open = function () {
		return specificationEnvironment(tw, {
			wiki: fixture.wiki,
			platform: platform,
			documents: [agentCallDocument],
			executors: {
				"spec-external-operation": react
			},
			agentTransport: function (request, metadata) {
				fixture.transports++;

				var call = fixture.registry().call;

				fixture.transportSawRunning =
					call.phase === "running" &&
					call.operation === metadata.id;

				assert(
					request.prompt === "Return forty-two",
					"Transport received the wrong request"
				);

				if (options.transport) {
					return options.transport(request, metadata);
				}

				return Promise.resolve({ answer: 42 });
			}
		});
	};

	return fixture;
}


function afterCurrentMicrotasks() {
	return new Promise(function (resolve) {
		setTimeout(resolve, 0);
	});
}


async function externalEffectsBeginAfterCommit(tw) {
	await submission(false);
	await submission(true);

	async function submission(fail) {
		var fixture = agentCallFixture(tw, {
			failAfterSubmit: fail
		});
		var environment = fixture.open();

		try {
			environment.start();

			if (fail) {
				var errors = environment.dispatcher.inspect().errors;

				assert(
					errors.length === 1 &&
						errors[0].phase === "reaction" &&
						errors[0].message === "Proposal rejected after submit",
					"The rejected submission lost its reaction diagnostic"
				);

				assert(
					fixture.transports === 0 &&
						fixture.ticks === 0 &&
						fixture.registry().call.phase === "idle" &&
						fixture.registry().charter.status.phase === "suspended",
					"The rejected submission published work before dispatch returned"
				);

				var rejectedOwner = JSON.stringify(
					effects.capture(
						fixture.wiki.getTiddler(fixture.title)
					)
				);

				function assertNoExternalWork() {
					var inspection = environment.dispatcher.inspect();

					assert(
						fixture.transports === 0 &&
							fixture.ticks === 0,
						"A rejected proposal initiated transport or notified its owner"
					);

					assert(
						JSON.stringify(
							effects.capture(
								fixture.wiki.getTiddler(fixture.title)
							)
						) === rejectedOwner,
						"Processing external work changed the rejected submission"
					);

					assert(
						inspection.pendingFlowMessages === 0 &&
							inspection.agentErrors.length === 0,
						"The rejected submission left pending messages or driver errors"
					);
				}

				// start() already scanned the driver. Allow any transport
				// microtasks incorrectly scheduled by that pass to run.
				await afterCurrentMicrotasks();
				assertNoExternalWork();

				// Further production scans must not discover a request
				// left behind by the aborted proposal.
				environment.dispatcher.scan();
				await afterCurrentMicrotasks();
				assertNoExternalWork();

				environment.dispatcher.scan();
				await afterCurrentMicrotasks();
				assertNoExternalWork();
			} else {
				await waitFor(function () {
					var inspection = environment.dispatcher.inspect();

					assert(
						inspection.errors.length === 0 &&
							inspection.agentErrors.length === 0,
						"External call failed before completion: " +
							JSON.stringify(inspection)
					);

					return fixture.registry()
						.charter.status.phase === "completed";
				}, 2000, "the persisted external response and owner notification");

				assert(
					fixture.transports === 1 &&
						fixture.ticks === 1 &&
						fixture.transportSawRunning,
					"Transport or notification bypassed durable state"
				);

				assert(
					environment.dispatcher.inspect().errors.length === 0,
					"The completed call produced executor errors"
				);
			}

			assert(
				fixture.submissionDeferred,
				"Submitting caused an immediate external effect"
			);

			assert(
				environment.dispatcher.inspect().agentErrors.length === 0,
				"The call produced unexpected driver errors"
			);
		} finally {
			environment.stop();
		}
	}
}


/*
Stopping the driver revokes permission to begin transport.

The request may already be durably marked running, but a queued
Promise continuation must not initiate it after stop().
*/

async function stoppingTheDriverPreventsPendingTransport(tw) {
	var fixture = agentCallFixture(tw);
	var environment = fixture.open();

	try {
		environment.start();

		assert(
			fixture.registry().call.phase === "running" &&
				fixture.transports === 0,
			"The scenario did not reach durable running state before transport"
		);

		// Let the first launch microtask run. Any transport continuation
		// it schedules must still respect a subsequent stop().
		await Promise.resolve();

		assert(
			fixture.transports === 0,
			"Transport began before the scenario could exercise pending launch"
		);

		environment.stop();

		var ownerAfterStop = JSON.stringify(
			effects.capture(fixture.wiki.getTiddler(fixture.title))
		);

		await afterCurrentMicrotasks();

		assert(
			fixture.transports === 0,
			"The stopped driver initiated a pending transport"
		);

		assert(
			fixture.ticks === 0 &&
				JSON.stringify(
					effects.capture(fixture.wiki.getTiddler(fixture.title))
				) === ownerAfterStop,
			"The stopped driver notified its owner or changed persisted state"
		);
	} finally {
		environment.stop();
	}
}


/*
A queued transport continuation does not retain custody authority.

Handing the registry to the human before transport begins prevents
the request without fabricating a response or a driver failure.
*/

async function pendingTransportRequiresCurrentCustody(tw) {
	var fixture = agentCallFixture(tw);
	var environment = fixture.open();

	try {
		environment.start();

		assert(
			fixture.registry().call.phase === "running" &&
				fixture.transports === 0,
			"The scenario did not reach durable running state before transport"
		);

		// Exercise the gap between launch validation and actual transport.
		await Promise.resolve();

		assert(
			fixture.transports === 0,
			"Transport began before the custody intervention"
		);

		fixture.wiki.addTiddler(new tw.Tiddler(
			fixture.wiki.getTiddler(fixture.title),
			{ "clerus-custody": "user" }
		));

		var handedOffOwner = JSON.stringify(
			effects.capture(fixture.wiki.getTiddler(fixture.title))
		);

		await afterCurrentMicrotasks();

		function assertNoExternalWork() {
			var inspection = environment.dispatcher.inspect();

			assert(
				fixture.transports === 0 &&
					fixture.ticks === 0,
				"The driver initiated transport or notified an owner after custody loss"
			);

			assert(
				JSON.stringify(
					effects.capture(fixture.wiki.getTiddler(fixture.title))
				) === handedOffOwner,
				"The driver rewrote the handed-off registry"
			);

			assert(
				inspection.errors.length === 0 &&
					inspection.agentErrors.length === 0,
				"Custody loss became an executor or driver failure: " +
					JSON.stringify(inspection)
			);
		}

		assertNoExternalWork();

		environment.dispatcher.scan();
		await afterCurrentMicrotasks();

		assertNoExternalWork();
	} finally {
		environment.stop();
	}
}


/*
Once transport begins, custody loss cannot undo the external request.

It does revoke permission to persist its late response or notify
the owner. The driver must leave the intervening state untouched.
*/

async function lateResponsesRequireCurrentCustody(tw) {
	var resolveResponse;

	var response = new Promise(function (resolve) {
		resolveResponse = resolve;
	});

	var fixture = agentCallFixture(tw, {
		transport: function () {
			return response;
		}
	});

	var environment = fixture.open();

	try {
		environment.start();

		await afterCurrentMicrotasks();

		assert(
			fixture.transports === 1 &&
				fixture.transportSawRunning &&
				fixture.registry().call.phase === "running" &&
				fixture.ticks === 0,
			"The scenario did not reach an unfinished external request"
		);

		fixture.wiki.addTiddler(new tw.Tiddler(
			fixture.wiki.getTiddler(fixture.title),
			{ "clerus-custody": "user" }
		));

		var handedOffOwner = JSON.stringify(
			effects.capture(fixture.wiki.getTiddler(fixture.title))
		);

		resolveResponse({ answer: 42 });
		await afterCurrentMicrotasks();

		function assertPreserved() {
			var inspection = environment.dispatcher.inspect();

			assert(
				fixture.transports === 1 &&
					fixture.ticks === 0,
				"The late response repeated transport or notified the former owner"
			);

			assert(
				JSON.stringify(
					effects.capture(fixture.wiki.getTiddler(fixture.title))
				) === handedOffOwner,
				"The late response overwrote the handed-off registry"
			);

			assert(
				inspection.errors.length === 0 &&
					inspection.agentErrors.length === 0,
				"The stale response became an executor or driver failure: " +
					JSON.stringify(inspection)
			);
		}

		assertPreserved();

		environment.dispatcher.scan();
		await afterCurrentMicrotasks();

		assertPreserved();
	} finally {
		environment.stop();

		// Also release the controlled transport if an earlier assertion failed.
		resolveResponse({ answer: 42 });
	}
}


async function unknownExternalOutcomesRemainUnknown(tw) {
	var fixture = agentCallFixture(tw, {
		call: {
			form: "agent-call",
			id: "interrupted-call",
			sequence: "1",
			operation: "interrupted-call-1",
			phase: "running",
			request: { prompt: "Return forty-two" }
		}
	});

	fixture.wiki = restoredWiki(tw, fixture.wiki);

	var environment = fixture.open();

	try {
		environment.start();

		await waitFor(function () {
			var inspection = environment.dispatcher.inspect();

			assert(
				inspection.errors.length === 0 &&
					inspection.agentErrors.length === 0,
				"Uncertain outcome recovery failed: " +
					JSON.stringify(inspection)
			);

			return fixture.ticks === 1;
		}, 2000, "the owner notification of an uncertain external outcome");

		assert(
			fixture.transports === 0,
			"Recovery repeated a possibly executed request"
		);

		assert(
			fixture.registry().call.phase === "uncertain" &&
				fixture.registry().charter.status.phase === "uncertain",
			"Unknown outcome was not persisted and observed as uncertainty"
		);

		assert(
			environment.dispatcher.inspect().agentErrors.length === 0,
			"Uncertainty recovery produced driver errors"
		);
	} finally {
		environment.stop();
	}
}


function outputLimitsDoNotMasqueradeAsMalformedMessages(tw) {
	var response = {
		choices: [{
			finish_reason: "length",
			message: {
				role: "assistant",
				content: null
			}
		}]
	};

	var normalized = agentMessages.responseMessage(response);

	assert(
		normalized.role === "assistant" &&
			normalized.content === "" &&
			response.choices[0].message.content === null,
		"Output-limit normalization changed the raw response"
	);

	assertThrows(function () {
		agentMessages.responseMessage({
			choices: [{
				finish_reason: "stop",
				message: {
					role: "assistant",
					content: null
				}
			}]
		});
	}, "neither text nor tools");

	var partial = agentMessages.responseMessage({
		choices: [{
			finish_reason: "length",
			message: {
				role: "assistant",
				content: "Частичный ответ"
			}
		}]
	});

	assert(
		partial.content === "Частичный ответ",
		"Output-limit handling lost partial text"
	);
}


/*
10. RETENTION FOLLOWS FACTS AND ACCEPTED OBLIGATIONS
===================================================

Jobs are service entities, not permanent archive records.

Retention is derived from current authoritative facts.
An active mission retains its holder. An operational job-title
document retains the job it names.

Neither arbitrary strings inside document data nor historical
delivery metadata constitute such references.

Accepted unfinished work also retains the jobs needed to complete
it: owners, recipients and future operational references.
Pausing an obligation does not discharge it.

As accepted work completes, its retention grounds disappear or
become ordinary operational facts. No separate retention history
needs to be persisted.

Incomplete knowledge does not authorize destruction.
Unreadable obligations or operational registries prevent the
analysis from reporting collection candidates.

Being unretained is necessary, but not sufficient, for deletion.
Collection also requires local custody, valid structural facts
and a supported destruction protocol.

Inspection never collects jobs.

A collection pass considers its initial candidates and rechecks
current facts before deletion. Removing a superior can release
subordinates for a later pass.

Automatic collection runs at a dispatch boundary. Durable deferred
work retains its recipient through WAL until that work completes;
it does not require a global collection barrier.
*/

function retentionFollowsCurrentOperationalFacts(tw) {
	var fixture = delegationFixture(tw);
	var workerBefore = JSON.stringify(fixture.worker.registry);
	var jobsBefore = JSON.stringify(fixture.jobs);

	function inspect() {
		return jobRetention.evaluate(fixture.wiki, fixture.jobs);
	}

	function retained(report, title) {
		return report.retained.some(function (entry) {
			return entry.title === title;
		});
	}

	var initial = inspect();

	assert(
		initial.complete &&
			initial.retained.length === 3 &&
			initial.candidates.length === 0,
		"Active assignments did not retain the initial organization"
	);

	assert(
		JSON.stringify(fixture.jobs) === jobsBefore,
		"Computing retention changed authoritative records"
	);

	// Revocation removes mission authority, not the title reference.
	delete fixture.director.registry.mission.children.department;

	var revoked = inspect();

	assert(
		retained(revoked, fixture.manager.title) &&
			retained(revoked, fixture.worker.title),
		"Loss of mission authority ignored surviving operational references"
	);

	// The worker now has neither an active mission nor a superior.
	delete fixture.manager.registry.subordinate;

	// A string inside memo data is not a job-title document.
	fixture.manager.registry.note = {
		form: "memo",
		data: { rememberedWorker: fixture.worker.title }
	};

	var released = inspect();

	assert(
		released.complete &&
			!retained(released, fixture.worker.title) &&
			released.candidates.indexOf(fixture.worker.title) !== -1,
		"Nested memo data retained a job without an official title reference"
	);

	assert(
		JSON.stringify(fixture.worker.registry) === workerBefore,
		"Changing retention rewrote the retained job's evidence"
	);

	// No persisted retention history is needed to restore the result.
	fixture.manager.registry.subordinate = fixture.worker.title;

	assert(
		retained(inspect(), fixture.worker.title),
		"Restoring a title reference did not restore retention"
	);
}


function pendingMessagesRetainCurrentDocumentsNotHistory(tw) {
	var fixture = delegationFixture(tw);
	var platform = tw.browser ? "browser" : "node";
	var director = fixture.director;
	var manager = fixture.manager;
	var worker = fixture.worker;

	delete director.registry.mission.children.department;
	delete director.registry.subordinate;
	delete manager.registry.subordinate;

	var rules = documentFlow.loadRules(specificationModules({}));
	var journalTitle =
		"$:/clerus/wal/" + platform + "/retention-pending";

	function address(job) {
		return {
			title: job.title,
			executor: "spec-retention",
			platform: platform
		};
	}

	var historical = messageEffects.create({
		id: "retention-historical",
		message: "order",
		source: address(director),
		recipient: address(manager),
		registry: {}
	}, rules);

	var pending = messageEffects.create({
		id: "retention-pending",
		message: "order",
		source: address(manager),
		recipient: address(worker),
		registry: {
			note: {
				form: "memo",
				data: { rememberedManager: manager.title }
			}
		}
	}, rules);

	var body = {
		version: 1,
		kind: "flow",
		platform: platform,
		active: null,
		pending: [clone(pending)],
		seen: {},
		errors: []
	};

	body.seen[historical.id] = historical;
	body.seen[pending.id] = pending;

	function store() {
		fixture.wiki.addTiddler(new tw.Tiddler({
			title: journalTitle,
			type: "application/json",
			"clerus-wal-kind": "flow",
			"clerus-custody": "user",
			text: JSON.stringify(body)
		}));
	}

	function inspect() {
		return jobRetention.evaluate(fixture.wiki, fixture.jobs);
	}

	function entry(report, job) {
		return report.retained.find(function (item) {
			return item.title === job.title;
		});
	}

	store();

	var journalBefore = JSON.stringify(
		effects.capture(fixture.wiki.getTiddler(journalTitle))
	);
	var report = inspect();

	assert(
		report.complete &&
			entry(report, worker) &&
			entry(report, worker).reasons.some(function (reason) {
				return reason.kind === "pending-message";
			}),
		"A paused pending message did not retain its recipient"
	);

	assert(
		!entry(report, manager) &&
			report.candidates.indexOf(manager.title) !== -1,
		"Sender metadata, memo data or deduplication history retained a job"
	);

	assert(
		JSON.stringify(
			effects.capture(fixture.wiki.getTiddler(journalTitle))
		) === journalBefore,
		"Inspecting pending retention changed the paused obligation"
	);
}


function acceptedPlansRetainOwnersAndFutureReferences(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/spec-retention-plan";
	var staff = "$:/clerus/jobs/spec-retention-plan-staff";

	function addJob(title) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "spec-retention",
			text: JSON.stringify({
				charter: { form: "charter", status: {} }
			})
		}));
	}

	addJob(owner);
	addJob(staff);

	var runtime = new Runtime({
		wiki: wiki,
		platform: platform
	});

	function inspect() {
		return jobRetention.evaluate(wiki, runtime.inspect().jobs);
	}

	var initial = inspect();

	assert(
		initial.complete &&
			initial.candidates.indexOf(owner) !== -1 &&
			initial.candidates.indexOf(staff) !== -1,
		"The scenario did not start with unretained jobs"
	);

	var plan = new workPlans.WorkPlan({
		wiki: wiki,
		Wiki: tw.Wiki,
		Tiddler: tw.Tiddler
	});

	var proposed = JSON.parse(wiki.getTiddler(owner).fields.text);
	proposed.staff = staff;

	plan.patch(owner, { text: JSON.stringify(proposed) });

	var wal = new Wal({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		idFactory: function () {
			return "retention-accepted-plan";
		}
	});

	var title;

	try {
		title = wal.record({
			title: owner,
			executor: "spec-retention",
			persistent: true
		}, plan.export(), {
			ownerState: plan.initial(owner)
		});
	} finally {
		plan.abort();
	}

	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(title),
		{ "clerus-custody": "user" }
	));

	var ownerBefore = JSON.stringify(
		effects.capture(wiki.getTiddler(owner))
	);
	var journalBefore = JSON.stringify(
		effects.capture(wiki.getTiddler(title))
	);
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
			hasReason(staff, "planned-operational-reference"),
		"The accepted plan did not retain its owner and future reference: " +
			JSON.stringify(report)
	);

	assert(
		JSON.stringify(
			effects.capture(wiki.getTiddler(owner))
		) === ownerBefore &&
			JSON.stringify(
				effects.capture(wiki.getTiddler(title))
			) === journalBefore,
		"Retention analysis materialized or changed the paused plan"
	);

	// Explicitly authorize and finish the accepted obligation.
	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(title),
		{ "clerus-custody": platform }
	));

	wal.resume(title);
	report = inspect();

	assert(
		report.complete &&
			!wiki.tiddlerExists(title) &&
			report.candidates.indexOf(owner) !== -1 &&
			hasReason(staff, "operational-reference") &&
			!hasReason(staff, "planned-operational-reference"),
		"Completed work did not replace planned retention with current facts: " +
			JSON.stringify(report)
	);
}


function incompleteRetentionDoesNotAuthorizeCollection(tw) {
	var fixture = delegationFixture(tw);

	delete fixture.director.registry.mission.children.department;
	delete fixture.manager.registry.subordinate;

	var before = jobRetention.evaluate(fixture.wiki, fixture.jobs);

	assert(
		before.complete &&
			before.candidates.indexOf(fixture.worker.title) !== -1,
		"The scenario did not establish an operationally unretained job"
	);

	var journalTitle = "$:/clerus/wal/node/retention-unreadable";

	fixture.wiki.addTiddler(new tw.Tiddler({
		title: journalTitle,
		type: "application/json",
		"clerus-custody": "user",
		text: "{"
	}));

	var journalBefore = JSON.stringify(
		effects.capture(fixture.wiki.getTiddler(journalTitle))
	);

	var uncertain = jobRetention.evaluate(fixture.wiki, fixture.jobs);

	assert(
		!uncertain.complete &&
			uncertain.candidates.length === 0 &&
			uncertain.unretained.indexOf(fixture.worker.title) !== -1,
		"Incomplete retention analysis reported collection candidates"
	);

	assert(
		JSON.stringify(
			effects.capture(fixture.wiki.getTiddler(journalTitle))
		) === journalBefore,
		"Retention analysis changed a paused WAL"
	);

	fixture.wiki.deleteTiddler(journalTitle);

	assert(
		jobRetention.evaluate(fixture.wiki, fixture.jobs).complete,
		"Retention completeness depended on persisted observation history"
	);

	// An unreadable operational registry can conceal title documents.
	fixture.manager.registry = null;

	var unreadable = jobRetention.evaluate(fixture.wiki, fixture.jobs);

	assert(
		!unreadable.complete &&
			unreadable.candidates.length === 0 &&
			unreadable.incomplete.some(function (item) {
				return item.kind === "uninspectable-registry" &&
					item.title === fixture.manager.title;
			}),
		"An unreadable registry allowed collection candidates"
	);
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


function explicitCollectionReleasesTheOrganizationInPasses(tw) {
	var fixture = collectionFixture(tw);
	var worker = fixture.add("worker");
	var director = fixture.add("director", {
		subordinate: worker
	});

	// A stored active root retains its holder even if its project
	// is temporarily absent and the task is not currently readable.
	var root = fixture.add("root", {
		mission: {
			form: "mission",
			project: "Collection Root Project",
			role: [],
			link: "10",
			issued: "0",
			children: {}
		}
	});

	var first = jobCollection.collect(fixture.runtime);

	assert(
		first.blocked.length === 0 &&
			first.removed.length === 1 &&
			first.removed[0] === director &&
			!!fixture.wiki.getTiddler(worker) &&
			!!fixture.wiki.getTiddler(root),
		"Collection did not preserve the initial retention boundary: " +
			JSON.stringify(first)
	);

	var perspective = fixture.runtime.inspect();

	assert(
		perspective.retention.candidates.indexOf(worker) !== -1,
		"Deleting a superior did not release its subordinate"
	);

	var second = jobCollection.collect(fixture.runtime);

	assert(
		second.blocked.length === 0 &&
			second.removed.length === 1 &&
			second.removed[0] === worker &&
			!!fixture.wiki.getTiddler(root),
		"A later collection pass did not collect the released subordinate: " +
			JSON.stringify(second)
	);

	var third = jobCollection.collect(fixture.runtime);

	assert(
		third.removed.length === 0 &&
			third.blocked.length === 0,
		"Repeated collection changed the retained organization"
	);
}


function collectionRespectsCustodyAndDestructionBoundaries(tw) {
	var fixture = collectionFixture(tw);
	var foreignPlatform =
		fixture.platform === "browser" ? "node" : "browser";

	var local = fixture.add("local");
	var user = fixture.add("user", {}, {
		"clerus-custody": "user"
	});
	var foreign = fixture.add("foreign", {}, {
		"clerus-custody": foreignPlatform
	});
	var newborn = fixture.add("newborn", {}, {
		"clerus-start": "unfinished-order"
	});
	var external = fixture.add("external", {
		call: {
			form: "agent-call",
			id: "collection-call",
			sequence: "1",
			phase: "running",
			operation: "collection-call-1"
		}
	});

	var protectedTitles = [user, foreign, newborn, external];
	var before = protectedTitles.map(function (title) {
		return effects.capture(fixture.wiki.getTiddler(title));
	});

	var result = jobCollection.collect(fixture.runtime);

	assert(
		result.blocked.length === 0 &&
			result.removed.length === 1 &&
			result.removed[0] === local,
		"Collection crossed an ownership or destruction boundary: " +
			JSON.stringify(result)
	);

	protectedTitles.forEach(function (title, index) {
		assert(
			sameJson(
				effects.capture(fixture.wiki.getTiddler(title)),
				before[index]
			),
			"Collection changed protected job: " + title
		);
	});

	assert(
		result.skipped.some(function (item) {
			return item.title === external &&
				item.reason === "unsupported-document-destruction";
		}),
		"Collection did not explain the external-operation boundary"
	);
}


async function automaticCollectionWaitsForPersistentTicks(tw) {
	var fixture = collectionFixture(tw);
	var title = fixture.add("persistent-tick");
	var readyCount = 0;
	var tickCount = 0;
	var environment;

	environment = specificationEnvironment(tw, {
		wiki: fixture.wiki,
		platform: fixture.platform,
		autoCollectJobs: true,
		executors: {
			"spec-collection": function (event, operational) {
				if (event.type === "ready") {
					readyCount++;

					operational.get("charter").defer();
					operational.get("charter").defer();
					return;
				}

				if (event.type !== "tick") {
					return;
				}

				tickCount++;

				assert(
					!!fixture.wiki.getTiddler(title),
					"Collection removed the persistent tick recipient"
				);

				var retention = environment.runtime.inspect().retention;
				var holder = retention.retained.find(function (entry) {
					return entry.title === title;
				});

				assert(
					holder &&
						holder.reasons.some(function (reason) {
							return reason.kind === "deferred-event";
						}),
					"The persistent tick was not retained by its WAL: " +
						JSON.stringify(retention)
				);

				operational.get("charter").setStatus({
					phase: "complete"
				});
			}
		}
	});

	try {
		environment.start();

		var retention = environment.runtime.inspect().retention;
		var retained = retention.retained.find(function (entry) {
			return entry.title === title;
		});
		var inspection = environment.dispatcher.inspect();

		assert(
			readyCount === 1 &&
				tickCount === 0 &&
				retention.complete &&
				retained &&
				retained.reasons.some(function (reason) {
					return reason.kind === "deferred-event";
				}),
			"The accepted deferred obligation did not retain its owner: " +
				JSON.stringify(retention)
		);

		assert(
			inspection.collection &&
				inspection.collection.blocked.length === 0 &&
				!!fixture.wiki.getTiddler(title),
			"Persistent deferral relied on a global collection barrier: " +
				JSON.stringify(inspection)
		);

		await waitFor(function () {
			var current = environment.dispatcher.inspect();

			assert(
				current.errors.length === 0,
				"Persistent tick collection failed: " +
					JSON.stringify(current)
			);

			return !fixture.wiki.getTiddler(title);
		}, 2000, "automatic collection after the persistent tick");

		assert(
			readyCount === 1 && tickCount === 1,
			"Persistent deferral was interrupted or delivered repeatedly"
		);

		var remaining = [];

		fixture.wiki.each(function (tiddler, walTitle) {
			if (
				walTitle.indexOf(
					"$:/clerus/wal/" + fixture.platform + "/"
				) === 0
			) {
				remaining.push(walTitle);
			}
		});

		assert(
			remaining.length === 0,
			"Completed tick collection left unfinished obligations: " +
				JSON.stringify(remaining)
		);
	} finally {
		environment.stop();
	}
}


function browserCredentialsStayOutsideWiki(tw) {
	function memoryStorage() {
		var values = Object.create(null);

		return {
			getItem: function (key) {
				return Object.prototype.hasOwnProperty.call(values, key)
					? values[key]
					: null;
			},

			setItem: function (key, value) {
				values[key] = String(value);
			},

			removeItem: function (key) {
				delete values[key];
			},

			values: values
		};
	}

	var session = memoryStorage();
	var persistent = memoryStorage();

	var store = browserCredentials.createStore({
		sessionStorage: session,
		localStorage: persistent
	});

	assert(
		store.getApiKey() === undefined,
		"An empty store unexpectedly supplied a credential"
	);

	store.setApiKey(" session-key ");

	assert(
		store.getApiKey() === "session-key" &&
			Object.keys(session.values).length === 1 &&
			Object.keys(persistent.values).length === 0,
		"The default credential did not stay in session storage"
	);

	store.setApiKey("persistent-key", true);

	assert(
		store.getApiKey() === "persistent-key" &&
			Object.keys(session.values).length === 0 &&
			Object.keys(persistent.values).length === 1,
		"Persistent storage retained the previous session credential"
	);

	store.setApiKey("replacement-session-key");

	assert(
		store.getApiKey() === "replacement-session-key" &&
			Object.keys(persistent.values).length === 0,
		"Returning to session storage left a persistent credential"
	);

	assertThrows(function () {
		store.setApiKey("invalid\nkey");
	});

	assert(
		store.getApiKey() === "replacement-session-key",
		"Invalid input changed the stored credential"
	);

	store.clear();

	assert(
		store.getApiKey() === undefined &&
			Object.keys(session.values).length === 0 &&
			Object.keys(persistent.values).length === 0,
		"Clearing credentials left a stored copy"
	);

	var inaccessible = browserCredentials.createStore({
		sessionStorage: {
			getItem: function () {
				throw new Error("Sensitive arbitrary storage error");
			},
			removeItem: function () {
				throw new Error("Sensitive arbitrary storage error");
			}
		},
		localStorage: persistent
	});

	assertThrows(function () {
		inaccessible.getApiKey();
	}, "Browser credential storage is unavailable");

	// A failure in the first store must not skip clearing the second.
	store.setApiKey("persistent-key", true);

	assertThrows(function () {
		inaccessible.clear();
	}, "Browser credential storage is unavailable");

	assert(
		Object.keys(persistent.values).length === 0,
		"Failure to clear session storage skipped persistent cleanup"
	);
}


function userLaunchSurvivesCollectionAndReactivation(tw) {
	var wiki = new tw.Wiki();
	var executions = 0;
	var executors = {};

	executors[projectProbe.name] = function (event, operational) {
		var before = operational.get("work").data();

		projectProbe.browser(event, operational);

		var after = operational.get("work").data();

		if (
			before.phase !== "finished" &&
			after.phase === "finished"
		) {
			executions++;
		}
	};

	function environment() {
		return specificationEnvironment(tw, {
			wiki: wiki,
			platform: "browser",
			autoCollectJobs: true,
			executors: executors
		});
	}

	function launchHost(env) {
		return {
			browser: true,
			wiki: wiki,
			Tiddler: tw.Tiddler,
			clerus: {
				dispatcher: env.dispatcher
			}
		};
	}

	var env = environment();
	var result;
	var finishedText;

	try {
		env.start();

		assertThrows(function () {
			projectLauncher.launch(launchHost(env), {
				prompt: "   "
			});
		}, "Task text is required");

		assert(
			env.runtime.inspect().jobs.length === 0,
			"Invalid input created a job"
		);

		result = projectLauncher.launch(launchHost(env), {
			prompt: "Проверить пользовательский запуск"
		});

		// Do not rely on TW's asynchronous change-event batching.
		env.dispatcher.scan();

		var job = wiki.getTiddler(result.job);
		var registry = JSON.parse(job.fields.text);

		assert(
			registry.charter.status.phase === "completed" &&
				registry.work.data.phase === "finished",
			"The launched project did not complete"
		);

		assert(
			executions === 1,
			"The initial task did not execute exactly once"
		);

		env.dispatcher.collectGarbage();

		assert(
			!!wiki.getTiddler(result.job),
			"Collection removed a job retained by its root mission"
		);

		assert(
			wiki.getTiddler(result.project)
				.fields["clerus-root-job"] === result.job,
			"The project lost its UI address"
		);

		finishedText = wiki.getTiddler(result.job).fields.text;
	} finally {
		env.stop();
	}

	env = environment();

	try {
		env.start();
		env.dispatcher.scan();

		assert(
			executions === 1,
			"Reactivation repeated the finished task"
		);

		assert(
			wiki.getTiddler(result.job).fields.text === finishedText,
			"Reactivation rewrote the finished registry"
		);
	} finally {
		env.stop();
	}
}


function answerProjectFixture(tw, transport, options) {
	options = options || {};

	var fixture = {
		wiki: new tw.Wiki(),
		transports: 0,
		result: null,
		transportSawCommittedRequest: false
	};

	fixture.registry = function () {
		return JSON.parse(
			fixture.wiki.getTiddler(fixture.result.job).fields.text
		);
	};

	fixture.open = function () {
		var executors = {};
		executors[projectAnswer.name] = projectAnswer.browser;

		return specificationEnvironment(tw, {
			wiki: fixture.wiki,
			platform: "browser",
			autoCollectJobs: true,
			documents: [
				agentCallDocument,
				agentSessionDocument,
				warrantDocument
			],
			executors: executors,
			agentTransport: function (request, metadata) {
				fixture.transports++;

				var registry = fixture.registry();

				fixture.transportSawCommittedRequest =
					registry.work.data.phase === "working" &&
					registry.session.phase === "waiting" &&
					registry.call.phase === "running" &&
					registry.call.operation === metadata.id;

				assert(
					request.model === "spec/model" &&
						request.messages.length === 1 &&
						request.messages[0].role === "user" &&
						sameJson(request, registry.call.request) &&
						sameJson(request, registry.session.pending.request),
					"The transport request differs from the committed session"
				);

				if (!options.sourceTitle) {
					assert(
						request.messages[0].content ===
							"Объясни назначение реестра",
						"The project submitted an unexpected prompt"
					);
				}

				return transport(request, metadata);
			}
		});
	};

	fixture.launch = function (environment) {
		fixture.result = projectLauncher.launch({
			browser: true,
			wiki: fixture.wiki,
			Tiddler: tw.Tiddler,
			clerus: {
				dispatcher: environment.dispatcher
			}
		}, {
			mode: "answer",
			model: "spec/model",
			prompt: "Объясни назначение реестра",
			sourceTitle: options.sourceTitle
		});

		environment.dispatcher.scan();
	};

	return fixture;
}

function assertAnswerProjectHealthy(environment) {
	var inspection = environment.dispatcher.inspect();

	assert(
		inspection.errors.length === 0 &&
			inspection.agentErrors.length === 0,
		"The answer project produced unexpected errors: " +
			JSON.stringify(inspection)
	);
}


async function userAnswerProjectsPersistTheirOutcomes(tw) {
	await outcome("completed");
	await outcome("failed");
	await outcome("uncertain");

	async function outcome(expected) {
		var fixture = answerProjectFixture(tw, function () {
			if (expected === "completed") {
				return Promise.resolve({
					choices: [{
						message: {
							role: "assistant",
							content: "Реестр хранит документы должности."
						}
					}]
				});
			}

			var error = new Error(
				expected === "failed"
					? "Request was not executed"
					: "Transport outcome is unknown"
			);

			if (expected === "failed") {
				error.definitelyNotExecuted = true;
			}

			return Promise.reject(error);
		});

		var environment = fixture.open();
		var settledText;

		try {
			environment.start();
			fixture.launch(environment);

			await waitFor(function () {
				assertAnswerProjectHealthy(environment);

				return fixture.registry().work.data.phase === "finished";
			}, 2000, "the answer project's " + expected + " outcome");

			var registry = fixture.registry();

			assert(
				registry.charter.status.phase === expected &&
					registry.work.data.outcome === expected,
				"The project published the wrong outcome"
			);

			assert(
				fixture.transports === 1 &&
					fixture.transportSawCommittedRequest,
				"The request bypassed committed project state"
			);

			if (expected === "completed") {
				var outputTitle = registry.output;
				var output = fixture.wiki.getTiddler(outputTitle);

				assert(
					outputTitle === fixture.result.project + "/Result" &&
						registry.charter.status.result === outputTitle &&
						!!output,
					"The project did not publish and file its result"
				);

				assert(
					output.fields.text === "Реестр хранит документы должности." &&
						output.fields.type === "text/plain" &&
						output.fields["clerus-custody"] === "browser" &&
						output.fields["clerus-source-project"] ===
							fixture.result.project &&
						output.fields["clerus-source-job"] === fixture.result.job,
					"The published result lost its content or provenance"
				);

				assert(
					registry.session.messages.length === 2 &&
						registry.session.phase === "ready",
					"The project lost or duplicated the accepted response"
				);
			} else {
				assert(
					registry.session.phase === expected &&
						registry.session.messages.length === 1 &&
						typeof registry.charter.status.error.message === "string",
					"The project lost its failed or uncertain outcome"
				);

				assert(
					!Object.prototype.hasOwnProperty.call(registry, "output") &&
						!fixture.wiki.getTiddler(
							fixture.result.project + "/Result"
						),
					"A failed or uncertain request published a result"
				);
			}

			environment.dispatcher.collectGarbage();

			assert(
				!!fixture.wiki.getTiddler(fixture.result.job),
				"Collection removed the retained project owner"
			);

			settledText = fixture.wiki
				.getTiddler(fixture.result.job).fields.text;
		} finally {
			environment.stop();
		}

		// Restore stored facts without the previous runtime's memory.
		fixture.wiki = restoredWiki(tw, fixture.wiki);
		environment = fixture.open();

		try {
			environment.start();
			environment.dispatcher.scan();
			await afterCurrentMicrotasks();

			assertAnswerProjectHealthy(environment);

			assert(
				fixture.transports === 1,
				"Reactivation repeated a settled external request"
			);

			assert(
				fixture.wiki.getTiddler(fixture.result.job).fields.text ===
					settledText,
				"Reactivation changed the finished project registry"
			);

			if (expected === "completed") {
				var restoredOutput = fixture.wiki.getTiddler(
					fixture.result.project + "/Result"
				);

				assert(
					restoredOutput &&
						restoredOutput.fields.text ===
							"Реестр хранит документы должности.",
					"Reactivation lost the published result"
				);
			}
		} finally {
			environment.stop();
		}
	}
}


async function interruptedAnswerProjectsDoNotRepeatTransport(tw) {
	var fixture = answerProjectFixture(tw, function () {
		// Represents an external operation whose outcome is unavailable.
		return new Promise(function () {});
	});

	var environment = fixture.open();

	try {
		environment.start();
		fixture.launch(environment);

		await waitFor(function () {
			assertAnswerProjectHealthy(environment);
			return fixture.transports === 1;
		}, 2000, "the external request to start");

		assert(
			fixture.registry().call.phase === "running" &&
				fixture.registry().session.phase === "waiting",
			"The interrupted operation was not stored as running"
		);
	} finally {
		environment.stop();
	}

	fixture.wiki = restoredWiki(tw, fixture.wiki);
	environment = fixture.open();

	try {
		environment.start();

		await waitFor(function () {
			assertAnswerProjectHealthy(environment);

			return fixture.registry().work.data.phase === "finished";
		}, 2000, "the interrupted project's uncertain outcome");

		var registry = fixture.registry();

		assert(
			fixture.transports === 1,
			"Recovery repeated a possibly executed request"
		);

		assert(
			registry.call.phase === "uncertain" &&
				registry.session.phase === "uncertain" &&
				registry.charter.status.phase === "uncertain" &&
				registry.work.data.outcome === "uncertain",
			"Uncertainty did not propagate through the complete project"
		);
	} finally {
		environment.stop();
	}
}


async function interruptedPublicationResumesWithoutRepeatingWork(tw) {
	var fixture = answerProjectFixture(tw, function () {
		return Promise.resolve({
			choices: [{
				message: {
					role: "assistant",
					content: "Сохранённый результат публикации."
				}
			}]
		});
	});

	var environment = fixture.open();
	var originalAdd = fixture.wiki.addTiddler;
	var interrupted = false;
	var journalTitle;
	var resultTitle;

	fixture.wiki.addTiddler = function (tiddler) {
		var result = originalAdd.call(this, tiddler);

		if (
			!interrupted &&
			fixture.result &&
			tiddler.fields.title === fixture.result.project + "/Result"
		) {
			interrupted = true;
			throw new Error("Interrupted after publication write");
		}

		return result;
	};

	try {
		environment.start();
		fixture.launch(environment);

		resultTitle = fixture.result.project + "/Result";

		await waitFor(function () {
			var errors = environment.dispatcher.inspect().errors;

			var diagnostic = errors.find(function (error) {
				return error.title === fixture.result.job &&
					error.phase === "commit" &&
					!!error.walTitle;
			});

			if (diagnostic) {
				journalTitle = diagnostic.walTitle;
			}

			return interrupted && !!journalTitle;
		}, 2000, "the interrupted publication's commit diagnostic");

		assert(
			fixture.transports === 1 &&
				fixture.transportSawCommittedRequest,
			"The publication did not follow one committed external call"
		);

		assert(
			fixture.wiki.getTiddler(resultTitle).fields.text ===
				"Сохранённый результат публикации.",
			"The interruption occurred before the result was written"
		);

		var journal = fixture.wiki.getTiddler(journalTitle);
		var record = JSON.parse(journal.fields.text);

		assert(
			journal.fields["clerus-custody"] === "user" &&
				journal.fields["clerus-wal-kind"] === "flow" &&
				record.active &&
				record.active.owner.title === fixture.result.job &&
				record.errors.length === 0,
			"The interrupted publication lost its active obligation"
		);

		var owner = fixture.wiki.getTiddler(fixture.result.job);

		assert(
			owner.fields["clerus-custody"] === "browser" &&
				owner.fields["clerus-suspended"] !== "yes",
			"A materialization failure suspended the executor"
		);

		assert(
			environment.dispatcher.materializationBlockers({
				title: fixture.result.job,
				persistent: true
			}).length > 0,
			"The paused publication did not block new owner reactions"
		);
	} finally {
		environment.stop();
		fixture.wiki.addTiddler = originalAdd;
	}

	/*
	First restart: user custody must prevent automatic continuation.
	No runtime memory crosses the restoration boundary.
	*/
	fixture.wiki = restoredWiki(tw, fixture.wiki);

	var pausedOwnerText = fixture.wiki
		.getTiddler(fixture.result.job).fields.text;
	var pausedJournalText = fixture.wiki
		.getTiddler(journalTitle).fields.text;

	environment = fixture.open();

	try {
		environment.start();
		await afterCurrentMicrotasks();
		environment.dispatcher.scan();

		assertAnswerProjectHealthy(environment);

		assert(
			fixture.transports === 1 &&
				fixture.wiki.getTiddler(journalTitle)
					.fields["clerus-custody"] === "user" &&
				fixture.wiki.getTiddler(journalTitle).fields.text ===
					pausedJournalText &&
				fixture.wiki.getTiddler(fixture.result.job).fields.text ===
					pausedOwnerText,
			"Restart silently continued the paused publication"
		);
	} finally {
		environment.stop();
	}

	/*
	Explicit authorization while stopped.
	This permits continuation of the accepted plan, not a new request.
	*/
	fixture.wiki.addTiddler(new tw.Tiddler(
		fixture.wiki.getTiddler(journalTitle),
		{ "clerus-custody": "browser" }
	));

	fixture.wiki = restoredWiki(tw, fixture.wiki);

	var restoredAdd = fixture.wiki.addTiddler;
	var repeatedResultWrites = 0;

	fixture.wiki.addTiddler = function (tiddler) {
		if (tiddler.fields.title === resultTitle) {
			repeatedResultWrites++;
		}

		return restoredAdd.call(this, tiddler);
	};

	environment = fixture.open();

	try {
		environment.start();

		await waitFor(function () {
			assertAnswerProjectHealthy(environment);

			return !fixture.wiki.getTiddler(journalTitle) &&
				fixture.registry().work.data.phase === "finished";
		}, 2000, "the authorized publication recovery");

		var registry = fixture.registry();
		var output = fixture.wiki.getTiddler(resultTitle);

		assert(
			fixture.transports === 1,
			"Publication recovery repeated the external request"
		);

		assert(
			repeatedResultWrites === 0,
			"Recovery rewrote an already materialized result"
		);

		assert(
			registry.output === resultTitle &&
				registry.charter.status.phase === "completed" &&
				registry.charter.status.result === resultTitle &&
				registry.session.phase === "ready" &&
				registry.session.messages.length === 2 &&
				output.fields.text ===
					"Сохранённый результат публикации.",
			"Recovery did not produce a consistent published result"
		);

		assert(
			fixture.wiki.getTiddler(fixture.result.job)
				.fields["clerus-custody"] === "browser",
			"Recovery changed owner custody"
		);
	} finally {
		environment.stop();
		fixture.wiki.addTiddler = restoredAdd;
	}
}


async function sourceChangesDoNotReplaceAcceptedInput(tw) {
	var sourceTitle = "Architectural Source Snapshot";
	var originalText =
		"Реестр хранит документы. Документы задают полномочия.";
	var changedText =
		"Этот текст появился после отправки запроса.";

	var complete;
	var sentRequest;

	var fixture = answerProjectFixture(tw, function (request) {
		sentRequest = clone(request);

		return new Promise(function (resolve) {
			complete = resolve;
		});
	}, {
		sourceTitle: sourceTitle
	});

	fixture.wiki.addTiddler(new tw.Tiddler({
		title: sourceTitle,
		type: "text/plain",
		"clerus-custody": "user",
		text: originalText
	}));

	var environment = fixture.open();

	try {
		environment.start();
		fixture.launch(environment);

		await waitFor(function () {
			assertAnswerProjectHealthy(environment);
			return typeof complete === "function";
		}, 2000, "the source-based request to start");

		var accepted = fixture.registry();

		assert(
			accepted.work.data.source.title === sourceTitle &&
				accepted.work.data.source.text === originalText &&
				accepted.source === sourceTitle,
			"The executor did not retain the accepted source snapshot"
		);

		assert(
			sentRequest.messages[0].content.indexOf(
				JSON.stringify([{
					title: sourceTitle,
					label: sourceTitle,
					text: originalText
				}])
			) !== -1,
			"The submitted request omitted the accepted source"
		);

		fixture.wiki.addTiddler(new tw.Tiddler(
			fixture.wiki.getTiddler(sourceTitle),
			{ text: changedText }
		));

		environment.dispatcher.scan();
		await afterCurrentMicrotasks();

		var waiting = fixture.registry();

		assert(
			fixture.transports === 1 &&
				waiting.session.phase === "waiting" &&
				waiting.work.data.source.text === originalText &&
				sameJson(waiting.call.request, sentRequest) &&
				sameJson(waiting.session.pending.request, sentRequest),
			"A source edit replaced or repeated the accepted request"
		);

		complete({
			choices: [{
				message: {
					role: "assistant",
					content: "Объяснение исходного снимка."
				}
			}]
		});

		await waitFor(function () {
			assertAnswerProjectHealthy(environment);
			return fixture.registry().work.data.phase === "finished";
		}, 2000, "publication of the source-based answer");

		var finished = fixture.registry();
		var output = fixture.wiki.getTiddler(finished.output);

		assert(
			finished.charter.status.phase === "completed" &&
				finished.work.data.source.text === originalText &&
				finished.session.messages.length === 2 &&
				sameJson(finished.call.request, sentRequest),
			"Completion lost or replaced the accepted source"
		);

		assert(
			output &&
				output.fields.text === "Объяснение исходного снимка." &&
				output.fields["clerus-source-tiddler"] === sourceTitle,
			"The published answer lost its source provenance"
		);

		assert(
			fixture.wiki.getTiddler(sourceTitle).fields.text ===
				changedText,
			"Publication overwrote the user's source edit"
		);

		assert(
			fixture.transports === 1,
			"The source edit caused another external request"
		);
	} finally {
		environment.stop();
	}
}


function sourceCaptureCopiesTextWithoutExecutingIt(tw) {
	var wiki = new tw.Wiki();
	var sourceTitle = "$:/plugins/spec/example.js";
	var sourceText =
		"throw new Error('This source must never execute');";

	wiki.addTiddler(new tw.Tiddler({
		title: sourceTitle,
		type: "application/javascript",
		"module-type": "library",
		text: sourceText
	}));

	var host = {
		wiki: wiki,
		Tiddler: tw.Tiddler
	};

	var result = sourceSnapshots.capture(host, {
		title: sourceTitle
	});

	var snapshot = wiki.getTiddler(result.title);

	assert(
		snapshot.fields.type === "text/plain" &&
			snapshot.fields.text === sourceText &&
			snapshot.fields["clerus-custody"] === "user" &&
			snapshot.fields["clerus-source-title"] === sourceTitle &&
			snapshot.fields["clerus-source-module-type"] === "library",
		"The snapshot lost source text or provenance"
	);

	wiki.addTiddler(new tw.Tiddler(
		wiki.getTiddler(sourceTitle),
		{ text: "Changed source" }
	));

	assert(
		wiki.getTiddler(result.title).fields.text === sourceText,
		"A source change rewrote its existing snapshot"
	);

	assertThrows(function () {
		sourceSnapshots.capture(host, {
			title: "Ordinary source"
		});
	}, "system JavaScript");

	assertThrows(function () {
		sourceSnapshots.capture(host, {
			title: "$:/clerus/jobs/example"
		});
	}, "Runtime state");

	wiki.addTiddler(new tw.Tiddler({
		title: "$:/spec/non-javascript",
		type: "application/json",
		text: "{}"
	}));

	assertThrows(function () {
		sourceSnapshots.capture(host, {
			title: "$:/spec/non-javascript"
		});
	}, "JavaScript");
}


/*
EXECUTABLE CONTENTS
===================

The order is explanatory, not an execution dependency.
Each scenario constructs its own state.
*/

var chapters = [
	{
		principle: "Authoritative facts produce a derived perspective",
		scenarios: [
			authorityChangesWithoutRewritingItsEvidence
		]
	},
	{
		principle: "Observation turns changed facts into work",
		scenarios: [
			projectChangesDriveDocumentReactions
		]
	},
	{
		principle: "Documents expose bounded capabilities",
		scenarios: [
			scopedDocuments,
			writesRequireIndependentPermissions,
			warrantsDependOnCurrentMissionAuthority
		]
	},
	{
		principle: "Assignments are valid within a legal organization",
		scenarios: [
			hierarchyHasStructuralLimits,
			delegationRequiresAnActiveParent,
			aliasesDoNotMultiplyAuthority,
			revokedLabelsAreNotReused
		]
	},
	{
		principle: "Document flow changes the organization",
		scenarios: [
			transferPreservesIdentity,
			staffAuthorityDependsOnTransferredRelationships,
			establishmentPrecedesOrdinaryActivation
		]
	},
	{
		principle: "Execution modes have distinct failure contracts",
		scenarios: [
			ephemeralFailureDoesNotUndoMaterializedWork,
			reactionsProposeIsolatedWork,
			executorsCannotReturnAsynchronousContinuations
		]
	},
	{
		principle: "Official messages form synchronous causal waves",
		scenarios: [
			messagesHaveIdentityAndLimitedDisclosure,
			officialMessagesCompleteWithinOneDispatchPass,
			unavailableRecipientsPreservePendingMessages,
			reportingHasAnExplicitCausalBoundary
		]
	},
	{
		principle: "Accepted obligations survive interruption",
		scenarios: [
			acceptedWorkSurvivesInfrastructureFailure,
			acceptedPlansRecoverFromPartialMaterialization,
			recoveryDoesNotOverwriteIntervention,
			recoveryDoesNotReclaimTargetCustody,
			acceptedWorkSurvivesUpperGrantRevocation,
			recoveryRequiresTheRecordedOwner
		]
	},
	{
		principle: "External effects have knowledge and authority boundaries",
		scenarios: [
			externalEffectsBeginAfterCommit,
			stoppingTheDriverPreventsPendingTransport,
			pendingTransportRequiresCurrentCustody,
			lateResponsesRequireCurrentCustody,
			unknownExternalOutcomesRemainUnknown,
			outputLimitsDoNotMasqueradeAsMalformedMessages
		]
	},
	{
		principle: "Retention follows current facts and accepted obligations",
		scenarios: [
			retentionFollowsCurrentOperationalFacts,
			pendingMessagesRetainCurrentDocumentsNotHistory,
			acceptedPlansRetainOwnersAndFutureReferences,
			incompleteRetentionDoesNotAuthorizeCollection,
			explicitCollectionReleasesTheOrganizationInPasses,
			collectionRespectsCustodyAndDestructionBoundaries,
			automaticCollectionWaitsForPersistentTicks
		]
	},
	{
		principle: "Browser credentials remain outside authoritative wiki state",
		scenarios: [
			browserCredentialsStayOutsideWiki
		]
	},
	{
		principle: "User launches become retained persistent projects",
		scenarios: [
			userLaunchSurvivesCollectionAndReactivation
		]
	},
	{
		principle: "User projects preserve external outcomes without silent retries",
		scenarios: [
			userAnswerProjectsPersistTheirOutcomes,
			interruptedAnswerProjectsDoNotRepeatTransport,
			interruptedPublicationResumesWithoutRepeatingWork
		]
	},
	{
		principle: "Source-based projects operate on accepted snapshots",
		scenarios: [
			sourceChangesDoNotReplaceAcceptedInput
		]
	},
	{
		principle: "System sources become explicit ordinary snapshots",
		scenarios: [
			sourceCaptureCopiesTextWithoutExecutingIt
		]
	}
];


/*
Preserve the existing runner's result contract:
    { passed, results: [{ name, passed, error }] }

A failure in one witness must not hide the remaining architecture.
*/

exports.run = async function (tw) {
	var results = [];

	for (var i = 0; i < chapters.length; i++) {
		var chapter = chapters[i];

		for (var j = 0; j < chapter.scenarios.length; j++) {
			var scenario = chapter.scenarios[j];
			var name = chapter.principle + ": " + scenario.name;

			try {
				await scenario(tw);

				results.push({
					name: name,
					passed: true,
					error: null
				});
			} catch (error) {
				results.push({
					name: name,
					passed: false,
					error: String(error && error.stack || error)
				});
			}
		}
	}

	return {
		passed: results.every(function (result) {
			return result.passed;
		}),
		results: results
	};
};