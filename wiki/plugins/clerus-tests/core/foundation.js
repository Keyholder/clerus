/*\
title: $:/plugins/clerus/tests/core/foundation.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var stores = require("$:/plugins/clerus/core/store.js");
var jobState = require("$:/plugins/clerus/core/job-state.js");
var Plan = require("$:/plugins/clerus/core/plan.js").Plan;
var jobViews = require("$:/plugins/clerus/core/job-view.js");
var reactionServices = require(
	"$:/plugins/clerus/core/reaction-services.js"
);
var executionContract = require(
	"$:/plugins/clerus/core/execution-contract.js"
);
var reactionEvents = require(
	"$:/plugins/clerus/core/reaction-event.js"
);
var establishmentInput = require(
	"$:/plugins/clerus/core/establishment-input.js"
);
var PassCoordinator = require(
	"$:/plugins/clerus/core/external-pass.js"
).Coordinator;
var acceptedPlans = require(
	"$:/plugins/clerus/core/accepted-plan-schema.js"
);
var deferredSchema = require(
	"$:/plugins/clerus/core/deferred-schema.js"
);
var incidentSchema = require(
	"$:/plugins/clerus/core/incident-schema.js"
);
var walEnvelope = require(
	"$:/plugins/clerus/core/wal-envelope.js"
);
var messageEffects = require(
	"$:/plugins/clerus/core/message-effect.js"
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

function charter() {
	return {
		form: "charter",
		status: {}
	};
}

function testRegistries() {
	[null, [], true, 1, "text"].forEach(function (value) {
		throws(function () {
			schemas.registry(value, "operational");
		});
	});

	throws(function () {
		schemas.registry({}, "operational");
	}, "exactly one charter");

	throws(function () {
		schemas.registry({
			first: charter(),
			second: charter()
		}, "operational");
	}, "exactly one charter");

	throws(function () {
		schemas.registry({
			charter: charter()
		}, "incoming");
	}, "cannot contain a charter");

	throws(function () {
		schemas.document({ form: "memo" });
	}, "must contain data");

	var source = {
		charter: charter(),
		note: {
			form: "memo",
			data: { value: 1 }
		}
	};

	var result = schemas.registry(source, "operational");

	result.note.data.value = 2;

	assert(source.note.data.value === 1, "Validation leaked a reference");

	var safe = schemas.registry(JSON.parse(
		'{"__proto__":{"form":"memo","data":{"value":1}}}'
	), "incoming");

	assert(Object.getPrototypeOf(safe) === null);
	assert(Object.prototype.hasOwnProperty.call(safe, "__proto__"));
	assert(safe.__proto__.data.value === 1);
}

function testJSONBoundary() {
	var invoked = false;
	var accessor = {};

	Object.defineProperty(accessor, "value", {
		enumerable: true,
		get: function () {
			invoked = true;
			return 1;
		}
	});

	throws(function () {
		schemas.copyJSON(accessor);
	});

	assert(!invoked, "Validation invoked an accessor");

	var cycle = {};
	cycle.self = cycle;

	throws(function () {
		schemas.copyJSON(cycle);
	}, "cycles");

	throws(function () {
		schemas.copyJSON({ value: undefined });
	});

	throws(function () {
		schemas.copyJSON([, 1]);
	});

	var shared = { value: 1 };
	var result = schemas.copyJSON({
		first: shared,
		second: shared
	});

	assert(result.first !== result.second);
	assert(result.first.value === 1 && result.second.value === 1);
}

function testJob() {
	var fields = {
		title: "$:/temp/clerus/jobs/browser/test",
		type: "application/json",
		"clerus-executor": "test",
		text: JSON.stringify({ charter: charter() })
	};

	assert(
		schemas.ephemeralJob(fields, "browser").custody === "user"
	);

	fields.text = "null";

	throws(function () {
		schemas.ephemeralJob(fields, "browser");
	}, "Registry must be a JSON record");
}

function testTransitions(tw) {
	var wiki = new tw.Wiki();
	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var title = "Core2 Transition Test";

	assert(store.read(title).kind === "absent");

	var creation = stores.transition(title, null, {
		title: title,
		text: "first"
	});

	assert(store.apply(creation) === "applied");
	assert(store.apply(creation) === "already-applied");

	var before = store.read(title).fields;

	var update = stores.transition(title, before, {
		title: title,
		text: "second"
	});

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		text: "intervention"
	}));

	throws(function () {
		store.apply(update);
	}, "conflict");

	assert(wiki.getTiddlerText(title) === "intervention");

	var removal = stores.transition(
		title,
		store.read(title).fields,
		null
	);

	assert(store.apply(removal) === "applied");
	assert(store.apply(removal) === "already-applied");
	assert(store.read(title).kind === "absent");
}

function testSnapshotIsolation(tw) {
	var wiki = new tw.Wiki();
	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	wiki.addTiddler(new tw.Tiddler({
		title: "Core2 Snapshot Test",
		text: "original"
	}));

	var view = store.read("Core2 Snapshot Test");
	view.fields.text = "local";

	assert(
		wiki.getTiddlerText("Core2 Snapshot Test") === "original"
	);
}

function testJobRegistryReading() {
	assert(jobState.readRegistry({
		type: "text/plain",
		text: "{}"
	}).kind === "unsupported");

	["null", "[]", "{broken"].forEach(function (text) {
		var result = jobState.readRegistry({
			type: "application/json",
			text: text
		});

		assert(result.kind === "unreadable");
		assert(result.registry === null);
	});

	assert(jobState.readRegistry({
		type: "application/json"
	}).kind === "unreadable");

	var structural = jobState.readRegistry({
		type: "application/json",
		text: JSON.stringify({
			future: { form: "future-document" }
		})
	});

	assert(structural.kind === "ready");
	assert(structural.registry.future.form === "future-document");

	// Structural readability does not imply an executable registry.
	throws(function () {
		schemas.registry(structural.registry, "operational");
	});
}

function testJobProjection() {
	var first = "$:/clerus/jobs/projection-a";
	var second = "$:/clerus/jobs/projection-b";

	var rows = [
		{
			title: second,
			type: "application/json",
			text: "null"
		},
		{
			title: "Ordinary",
			text: "ignored"
		},
		{
			title: first,
			type: "application/json",
			text: JSON.stringify({
				child: second,
				future: { form: "future-document" }
			})
		}
	];

	var before = JSON.stringify(rows);

	function read() {
		return jobState.readJobs(function (visit) {
			rows.forEach(function (fields) {
				visit(fields, fields.title);
			});
		});
	}

	var jobs = read();

	assert(jobs.length === 2);
	assert(jobs[0].title === first);
	assert(jobs[0].custody === "user");
	assert(jobs[0].executor === null);
	assert(jobs[0].registry.child === second);
	assert(jobs[1].registry === null);

	jobs[0].registry.future.form = "local";
	assert(read()[0].registry.future.form === "future-document");
	assert(JSON.stringify(rows) === before);

	var failure = new Error("enumeration failed");
	var caught;

	try {
		jobState.readJobs(function () {
			throw failure;
		});
	} catch (error) {
		caught = error;
	}

	assert(caught === failure, "Enumeration failure was hidden");
}

function testJobProjectionBranches() {
	var title = "$:/clerus/jobs/projection-branch";
	var fields = {
		title: title,
		type: "application/json",
		text: JSON.stringify({ value: "initial" })
	};

	var plan = new Plan({
		materialized: [fields],
		shadows: []
	});

	var active = plan;

	function read() {
		return jobState.readJobs(function (visit) {
			active.each(visit);
		});
	}

	try {
		var branch = plan.fork();
		var next = schemas.copyJSON(fields);
		next.text = JSON.stringify({ value: "proposed" });

		branch.apply(stores.transition(title, fields, next));

		active = branch;
		assert(read()[0].registry.value === "proposed");

		active = plan;
		assert(read()[0].registry.value === "initial");

		branch.abort();
		assert(read()[0].registry.value === "initial");
	} finally {
		plan.abort();
	}
}

function testExecutionHeader() {
	var fields = {
		type: "application/json",
		"clerus-executor": "test"
	};

	assert(jobState.hasExecutionHeader(fields));

	// Header readiness does not require custody or registry data.
	assert(!Object.prototype.hasOwnProperty.call(fields, "text"));

	[null, {}, {
		type: "text/plain",
		"clerus-executor": "test"
	}, {
		type: "application/json",
		"clerus-executor": ""
	}, {
		type: "application/json",
		"clerus-executor": 1
	}].forEach(function (value) {
		assert(!jobState.hasExecutionHeader(value));
	});
}

function testAddressedJobReading() {
	var title = "$:/clerus/jobs/addressed-reading";
	var stored = { kind: "absent", fields: null };

	var source = {
		read: function (requested) {
			assert(requested === title);
			return stored;
		}
	};

	assert(jobState.read(source, title).kind === "absent");

	stored = {
		kind: "shadow",
		fields: {
			title: title,
			type: "application/json",
			text: "{}"
		}
	};

	var shadow = jobState.read(source, title);
	assert(shadow.kind === "unsupported");
	assert(shadow.storage === "shadow");

	stored.kind = "materialized";
	stored.fields.text = "null";
	assert(jobState.read(source, title).kind === "unreadable");

	stored.fields.text = JSON.stringify({
		charter: { form: "charter", status: { value: 1 } }
	});

	var ready = jobState.read(source, title);
	assert(ready.kind === "ready");

	ready.fields.text = "local";
	ready.registry.charter.status.value = 2;

	assert(stored.fields.text !== "local");
	assert(
		jobState.read(source, title).registry.charter.status.value === 1
	);

	stored.fields.title = title + "-other";

	throws(function () {
		jobState.read(source, title);
	}, "identity mismatch");

	var failure = new Error("addressed source failure");
	var caught;

	try {
		jobViews.read({
			read: function () {
				throw failure;
			}
		}, title);
	} catch (error) {
		caught = error;
	}

	assert(caught === failure, "Source failure became unreadability");
}

function testPartialStatusReading() {
	var title = "$:/clerus/jobs/partial-status-reading";

	var source = {
		read: function () {
			return {
				kind: "materialized",
				fields: {
					title: title,
					type: "application/json",
					text: JSON.stringify({
						charter: {
							form: "charter",
							status: { phase: "available" }
						},
						future: { form: "future-document" }
					})
				}
			};
		}
	};

	var view = jobViews.read(source, title);

	assert(view.exists && view.readable);
	assert(view.status.phase === "available");

	view.status.phase = "local";
	assert(
		jobViews.read(source, title).status.phase === "available"
	);
}

function testOwnerOverlayIsolation() {
	var owner = "$:/clerus/jobs/overlay-owner";
	var other = "$:/clerus/jobs/overlay-other";

	var jobs = [
		{
			title: owner,
			custody: "user",
			executor: "owner",
			registry: {
				charter: charter(),
				old: { form: "memo", data: "stored" }
			}
		},
		{
			title: other,
			registry: {
				charter: charter(),
				note: { form: "memo", data: { value: 1 } }
			}
		}
	];

	var local = {
		charter: charter(),
		fresh: { form: "memo", data: { value: 2 } }
	};

	var beforeJobs = JSON.stringify(jobs);
	var beforeLocal = JSON.stringify(local);

	var perspective = jobState.overlayOwner(jobs, owner, local);

	assert(perspective.owner === perspective.jobs[0]);
	assert(perspective.owner.custody === "user");
	assert(perspective.owner.executor === "owner");
	assert(!perspective.owner.registry.old);
	assert(perspective.owner.registry.fresh.data.value === 2);

	perspective.owner.registry.fresh.data.value = 3;
	perspective.jobs[1].registry.note.data.value = 4;

	assert(JSON.stringify(jobs) === beforeJobs);
	assert(JSON.stringify(local) === beforeLocal);
}

function testOwnerOverlayBoundaries() {
	var title = "$:/clerus/jobs/overlay-boundaries";
	var jobs = [{ title: title, registry: null }];

	// Structural projection does not require a valid charter.
	var structural = jobState.overlayOwner(jobs, title, {
		future: { form: "future-document" }
	});

	assert(
		structural.owner.registry.future.form === "future-document"
	);

	var unestablished = jobState.overlayOwner(jobs, title, null);
	assert(unestablished.owner.registry === null);

	throws(function () {
		jobState.overlayOwner([], title, {});
	}, "exactly one owner snapshot");

	throws(function () {
		jobState.overlayOwner([
			{ title: title, registry: {} },
			{ title: title, registry: {} }
		], title, {});
	}, "exactly one owner snapshot");

	throws(function () {
		jobState.overlayOwner([null], title, {});
	}, "job records");

	throws(function () {
		jobState.overlayOwner(jobs, title, []);
	}, "operational record or null");
}

function testReactionServiceAssembly() {
	var title = "$:/clerus/jobs/service-assembly";
	var reads = 0;
	var enumerations = 0;
	var identities = 0;

	var source = {
		read: function () {
			assert(this === source, "State reader lost its receiver");
			reads++;

			return {
				kind: "absent",
				fields: null
			};
		}
	};

	var basic = reactionServices.create({
		title: title,
		platform: "browser",
		store: source
	});

	assert(Object.isFrozen(basic));
	assert(typeof basic.readTiddler === "function");
	assert(typeof basic.readJob === "function");
	assert(basic.readMission === undefined);
	assert(basic.prepareOrder === undefined);
	assert(basic.issueJobTitle === undefined);

	assert(reads === 0, "Service assembly performed state reads");

	assert(basic.readTiddler("Ordinary").kind === "absent");
	assert(!basic.readJob(title).exists);
	assert(reads === 2);

	var complete = reactionServices.create({
		title: title,
		platform: "browser",
		store: source,

		readJobs: function () {
			enumerations++;
			return [];
		},

		newId: function () {
			identities++;
			return "service-assembly-identity";
		}
	});

	[
		"readTiddler",
		"readJob",
		"readMission",
		"authorizeMission",
		"authorizeMissionMove",
		"authorizeOrganization",
		"prepareOrder",
		"prepareReport",
		"issueJobTitle"
	].forEach(function (name) {
		assert(
			typeof complete[name] === "function",
			"Missing reaction service: " + name
		);
	});

	assert(reads === 2, "Service assembly performed state reads");
	assert(enumerations === 0, "Service assembly enumerated jobs");
	assert(identities === 0, "Service assembly allocated an identity");

	throws(function () {
		reactionServices.create({
			title: title,
			platform: "browser",
			store: source,
			readJobs: null
		});
	}, "readJobs must be a function");
}

function testExecutionCompletionContract() {
	var event = { type: "test" };
	var operational = {};
	var incoming = {};
	var calls = [];

	var scope = {
		operational: operational,
		incoming: incoming,

		assertResolved: function () {
			calls.push("incoming");
		},

		assertOutgoingResolved: function () {
			calls.push("outgoing");
		}
	};

	function handler(receivedEvent, receivedOperational, receivedIncoming) {
		assert(this === undefined, "Executor received an adapter receiver");
		assert(receivedEvent === event);
		assert(receivedOperational === operational);
		assert(receivedIncoming === incoming);

		calls.push("handler");

		// A non-thenable return value has no execution significance.
		return { value: 1 };
	}

	executionContract.invoke({
		handler: handler,
		event: event,
		scope: scope,
		requireSentOutgoing: true
	});

	assert(calls.join(",") === "handler,incoming,outgoing");

	calls = [];

	executionContract.invoke({
		handler: handler,
		event: event,
		scope: scope
	});

	assert(calls.join(",") === "handler,incoming");
}

function testExecutionCompletionFailures() {
	var calls = [];
	var thenCalled = false;

	var scope = {
		operational: {},
		incoming: null,

		assertResolved: function () {
			calls.push("incoming");
		},

		assertOutgoingResolved: function () {
			calls.push("outgoing");
		}
	};

	throws(function () {
		executionContract.invoke({
			handler: function () {
				return {
					then: function () {
						thenCalled = true;
					}
				};
			},
			event: { type: "test" },
			scope: scope,
			requireSentOutgoing: true
		});
	}, "must be synchronous");

	assert(!thenCalled, "Execution contract invoked a thenable");
	assert(calls.length === 0);

	var failure = new Error("unresolved input");
	var caught;

	scope.assertResolved = function () {
		calls.push("incoming");
		throw failure;
	};

	try {
		executionContract.invoke({
			handler: function () {
				calls.push("handler");
			},
			event: { type: "test" },
			scope: scope,
			requireSentOutgoing: true
		});
	} catch (error) {
		caught = error;
	}

	assert(caught === failure, "Completion failure was replaced");
	assert(calls.join(",") === "handler,incoming");
}

function testReactionEventPreparation() {
	var source = {
		type: "test",
		title: "Untrusted title",
		platform: "node",
		payload: {
			items: [{ value: 1 }]
		}
	};

	var event = reactionEvents.prepare({
		event: source,
		title: "$:/clerus/jobs/event-owner",
		platform: "browser"
	});

	assert(event.type === "test");
	assert(event.title === "$:/clerus/jobs/event-owner");
	assert(event.platform === "browser");

	assert(Object.isFrozen(event));
	assert(Object.isFrozen(event.payload));
	assert(Object.isFrozen(event.payload.items));
	assert(Object.isFrozen(event.payload.items[0]));

	assert(!Object.isFrozen(source));
	assert(!Object.isFrozen(source.payload));
	assert(source.title === "Untrusted title");
	assert(source.platform === "node");

	source.payload.items[0].value = 2;
	assert(event.payload.items[0].value === 1);

	throws(function () {
		event.payload.items[0].value = 3;
	});

	assert(event.payload.items[0].value === 1);

	var safe = reactionEvents.prepare({
		event: JSON.parse(
			'{"type":"test","__proto__":{"value":1}}'
		),
		title: "$:/clerus/jobs/event-owner",
		platform: "browser"
	});

	assert(Object.getPrototypeOf(safe) === null);
	assert(
		Object.prototype.hasOwnProperty.call(safe, "__proto__")
	);
	assert(Object.isFrozen(safe.__proto__));
}

function testEstablishingReactionEvent() {
	var options = {
		title: "$:/clerus/jobs/event-establishment",
		platform: "browser",
		establishing: true
	};

	var event = reactionEvents.prepare(options);
	assert(event.type === "order");
	assert(Object.isFrozen(event));

	options.event = {
		type: "order",
		id: "explicit-order"
	};

	assert(
		reactionEvents.prepare(options).id === "explicit-order"
	);

	options.event = { type: "tick" };

	throws(function () {
		reactionEvents.prepare(options);
	}, "valid event type");

	options.event = null;

	throws(function () {
		reactionEvents.prepare(options);
	}, "valid event type");

	options.establishing = false;
	options.event = { type: "" };

	throws(function () {
		reactionEvents.prepare(options);
	}, "valid event type");

	var accessed = false;
	var supplied = { type: "test" };

	Object.defineProperty(supplied, "payload", {
		enumerable: true,
		get: function () {
			accessed = true;
			return {};
		}
	});

	options.event = supplied;

	throws(function () {
		reactionEvents.prepare(options);
	});

	assert(!accessed, "Event preparation invoked an accessor");
}

function testEstablishmentInput() {
	var source = {
		note: { form: "memo", data: { value: 1 } },
		mandate: {
			form: "contract",
			executor: "test",
			book: { instruction: "initial" }
		}
	};

	var before = JSON.stringify(source);

	var temporary = establishmentInput.read(source, {
		temporary: true
	});

	var persistent = establishmentInput.read(source, {
		temporary: false
	});

	assert(temporary.key === "mandate");
	assert(temporary.contract.executor === "test");
	assert(persistent.key === "mandate");

	temporary.contract.book.instruction = "local";
	assert(JSON.stringify(source) === before);

	throws(function () {
		establishmentInput.read({});
	}, "exactly one incoming contract");

	throws(function () {
		establishmentInput.read({
			first: source.mandate,
			second: source.mandate
		});
	}, "exactly one incoming contract");

	source.mandate.temp = false;

	throws(function () {
		establishmentInput.read(source, {
			temporary: true,
			durabilityError: "Adapter-specific durability rejection"
		});
	}, "Adapter-specific durability rejection");

	throws(function () {
		establishmentInput.read(source, { temporary: true });
	}, "forbids ephemeral");

	assert(
		establishmentInput.read(source, {
			temporary: false
		}).contract.temp === false
	);

	source.mandate.temp = true;

	throws(function () {
		establishmentInput.read(source, { temporary: false });
	}, "forbids persistent");

	assert(
		establishmentInput.read(source, {
			temporary: true
		}).contract.temp === true
	);

	// The document scope does not select a durability contract.
	assert(establishmentInput.read(source).key === "mandate");

	throws(function () {
		establishmentInput.read({}, {
			countError: "Adapter-specific contract count"
		});
	}, "Adapter-specific contract count");
}

function testExternalPassBoundaries() {
	var collections = 0;

	var passes = new PassCoordinator({
		autoCollect: true,

		collect: function () {
			collections++;
			assert(passes.depth === 0);
			return { sequence: collections };
		}
	});

	var receiver = {};

	var result = passes.run(receiver, function (value) {
		assert(this === receiver);
		assert(value === 42);
		assert(passes.depth === 1);

		passes.run(receiver, function () {
			assert(passes.depth === 2);
		}, [], true);

		assert(collections === 0);
		return "completed";
	}, [42], true);

	assert(result === "completed");
	assert(collections === 1);
	assert(passes.depth === 0);
	assert(passes.lastCollection.sequence === 1);

	// A non-collecting outer pass owns the entire boundary.
	passes.run(receiver, function () {
		passes.run(receiver, function () {}, [], true);
	}, [], false);

	assert(collections === 1);
	assert(passes.depth === 0);

	var disabled = new PassCoordinator({
		autoCollect: false,

		collect: function () {
			throw new Error("Disabled collection was invoked");
		}
	});

	disabled.run(receiver, function () {}, [], true);

	assert(disabled.depth === 0);
	assert(disabled.lastCollection === null);
}

function testExternalPassFailures() {
	var collections = 0;

	var passes = new PassCoordinator({
		autoCollect: true,

		collect: function () {
			collections++;
			throw new Error("Collector failure");
		}
	});

	var failure = new Error("Pass failure");
	var caught;

	try {
		passes.run(null, function () {
			passes.run(null, function () {}, [], true);
			throw failure;
		}, [], true);
	} catch (error) {
		caught = error;
	}

	assert(caught === failure);
	assert(passes.depth === 0);
	assert(collections === 0);
	assert(passes.lastCollection === null);

	var result = passes.run(null, function () {
		return "preserved result";
	}, [], true);

	assert(result === "preserved result");
	assert(passes.depth === 0);
	assert(collections === 1);
	assert(
		passes.lastCollection.blocked[0] === "collection-error"
	);
	assert(
		passes.lastCollection.failures[0].error.message ===
			"Collector failure"
	);
}

function testAcceptedPlanProtocol() {
	var title = "$:/clerus/jobs/accepted-schema-owner";

	var before = {
		title: title,
		type: "application/json",
		"clerus-executor": "test",
		"clerus-custody": "browser",
		text: JSON.stringify({
			charter: charter()
		})
	};

	var after = schemas.copyJSON(before);

	after.text = JSON.stringify({
		charter: {
			form: "charter",
			status: { phase: "completed" }
		}
	});

	var record = {
		version: 1,
		kind: "plan",
		platform: "browser",
		proposal: {
			version: 1,
			owner: {
				title: title,
				executor: "test",
				state: before
			},
			plan: {
				version: 1,
				effects: [
					stores.transition(title, before, after)
				]
			}
		}
	};

	var original = JSON.stringify(record);
	var result = acceptedPlans.validate(record, "browser");

	assert(result.version === 1);
	assert(result.proposal.plan.effects.length === 1);

	result.proposal.owner.state.text = "local";
	assert(JSON.stringify(record) === original);

	var future = schemas.copyJSON(record);
	future.version = 2;

	throws(function () {
		acceptedPlans.validate(future, "browser");
	}, "Invalid accepted-plan record");

	var extended = schemas.copyJSON(record);
	extended.future = {};

	throws(function () {
		acceptedPlans.validate(extended, "browser");
	}, "Invalid accepted-plan record");

	throws(function () {
		acceptedPlans.validate(record, "node");
	}, "Invalid accepted-plan record");

	var empty = schemas.copyJSON(record);
	empty.proposal.plan.effects = [];

	throws(function () {
		acceptedPlans.validate(empty, "browser");
	}, "must contain effects");

	assert(
		acceptedPlans.validate(
			empty,
			"browser",
			true
		).proposal.plan.effects.length === 0
	);

	var unauthorized = schemas.copyJSON(record);

	unauthorized.proposal.owner.state["clerus-custody"] = "user";
	unauthorized.proposal.plan.effects[0].before[
		"clerus-custody"
	] = "user";

	throws(function () {
		acceptedPlans.validate(unauthorized, "browser");
	}, "Invalid accepted target authority");
}

function testDeferredProtocol() {
	var record = {
		version: 1,
		kind: "deferred",
		platform: "browser",
		effect: {
			version: 1,
			kind: "deferred-event",
			id: "deferred-schema-identity",
			platform: "browser",
			recipient: {
				title: "$:/clerus/jobs/deferred-schema-owner",
				executor: "test"
			}
		}
	};

	var before = JSON.stringify(record);
	var result = deferredSchema.validate(record, "browser");

	assert(result.effect.id === record.effect.id);

	result.effect.recipient.executor = "local";
	assert(JSON.stringify(record) === before);

	var future = schemas.copyJSON(record);
	future.version = 2;

	throws(function () {
		deferredSchema.validate(future, "browser");
	}, "Invalid deferred obligation");

	var extended = schemas.copyJSON(record);
	extended.future = {};

	throws(function () {
		deferredSchema.validate(extended, "browser");
	}, "Invalid deferred obligation");

	var foreign = schemas.copyJSON(record);
	foreign.effect.platform = "node";

	throws(function () {
		deferredSchema.validate(foreign, "browser");
	}, "another platform");

	var futureEffect = schemas.copyJSON(record);
	futureEffect.effect.version = 2;

	throws(function () {
		deferredSchema.validate(futureEffect, "browser");
	}, "Invalid persistent deferred effect");

	throws(function () {
		deferredSchema.validate(record, "node");
	}, "Invalid deferred obligation");
}

function testIncidentProtocol() {
	var record = {
		version: 1,
		kind: "incident",
		platform: "browser",
		incident: {
			error: { message: "Historical failure" }
		}
	};

	var result = incidentSchema.validate(record, "browser");

	result.incident.error.message = "local";
	assert(record.incident.error.message === "Historical failure");

	var future = schemas.copyJSON(record);
	future.version = 2;

	throws(function () {
		incidentSchema.validate(future, "browser");
	}, "Invalid incident envelope");

	var extended = schemas.copyJSON(record);
	extended.future = {};

	throws(function () {
		incidentSchema.validate(extended, "browser");
	}, "Invalid incident envelope");

	throws(function () {
		incidentSchema.validate(record, "node");
	}, "Invalid incident envelope");

	var malformed = schemas.copyJSON(record);
	malformed.incident = [];

	throws(function () {
		incidentSchema.validate(malformed, "browser");
	}, "Invalid incident envelope");
}

function testWalEnvelopeReading() {
	var body = {
		version: 1,
		kind: "incident",
		platform: "browser",
		incident: {}
	};

	var fields = {
		title: "$:/clerus/wal/browser/envelope-test",
		type: "application/json",
		"clerus-custody": "user",
		"clerus-wal-kind": "incident",
		text: JSON.stringify(body)
	};

	function read(value) {
		fields.text = JSON.stringify(value);
		return walEnvelope.read(fields);
	}

	assert(walEnvelope.platformOf(fields.title) === "browser");
	assert(walEnvelope.platformOf("Ordinary") === null);

	var ready = read(body);

	assert(ready.kind === "ready");
	assert(ready.platform === "browser");

	ready.record.incident.local = true;
	assert(!read(body).record.incident.local);

	var future = schemas.copyJSON(body);
	future.version = 2;

	assert(read(future).kind === "unsupported");

	var malformed = schemas.copyJSON(body);
	malformed.version = "1";

	assert(read(malformed).kind === "unreadable");

	var foreign = schemas.copyJSON(body);
	foreign.platform = "node";

	assert(read(foreign).kind === "unreadable");

	var unknown = schemas.copyJSON(body);
	unknown.kind = "future";

	fields["clerus-wal-kind"] = "future";
	assert(read(unknown).kind === "unsupported");

	fields["clerus-wal-kind"] = "incident";
	assert(read(unknown).kind === "unreadable");

	fields.text = "{broken";
	assert(walEnvelope.read(fields).kind === "unreadable");

	fields.text = JSON.stringify(body);
	fields.type = "text/plain";
	assert(walEnvelope.read(fields).kind === "unreadable");

	// Envelope support does not imply body validity.
	fields.type = "application/json";
	assert(read({
		version: 1,
		kind: "incident",
		platform: "browser",
		incident: null
	}).kind === "ready");
}

function testRequiredWalEnvelope() {
	var fields = {
		title: "$:/clerus/wal/browser/required-envelope",
		type: "application/json",
		"clerus-custody": "user",
		"clerus-wal-kind": "flow",
		text: JSON.stringify({
			version: 1,
			kind: "flow",
			platform: "browser"
		})
	};

	var before = JSON.stringify(fields);

	// Supported outer envelope; body validation belongs to flow-schema.
	var record = walEnvelope.requireRecord(
		fields,
		"browser",
		"flow"
	);

	assert(record.kind === "flow");
	assert(JSON.stringify(fields) === before);
	assert(fields["clerus-custody"] === "user");

	throws(function () {
		walEnvelope.requireRecord(fields, "node", "flow");
	}, "another platform");

	throws(function () {
		walEnvelope.requireRecord(fields, "browser", "plan");
	}, "Unexpected WAL kind");

	var future = JSON.parse(fields.text);
	future.version = 2;
	fields.text = JSON.stringify(future);

	throws(function () {
		walEnvelope.requireRecord(fields, "browser", "flow");
	}, "Unsupported WAL version");

	future.version = 1;
	fields.text = JSON.stringify(future);
	fields["clerus-wal-kind"] = "plan";

	throws(function () {
		walEnvelope.requireRecord(fields, "browser", "flow");
	}, "Invalid WAL envelope");
}

function testEstablishingMessageContract() {
	var message = {
		version: 1,
		kind: "official-message",
		id: "foundation-establishing-message",
		platform: "browser",
		type: "order",
		establishing: true,

		source: {
			title: "$:/clerus/jobs/message-founder",
			executor: "founder"
		},

		recipient: {
			title: "$:/clerus/jobs/message-new-owner",
			executor: "worker"
		},

		registry: {
			mandate: {
				form: "contract",
				executor: "worker"
			}
		}
	};

	assert(messageEffects.validate(message).establishing);

	message.registry.mandate.temp = true;

	throws(function () {
		messageEffects.validate(message);
	}, "does not permit the recipient durability");

	// Executor mismatch must still precede durability rejection.
	message.registry.mandate.executor = "other";

	throws(function () {
		messageEffects.validate(message);
	}, "executor does not match the contract");

	message.registry.second = {
		form: "contract",
		executor: "worker"
	};

	throws(function () {
		messageEffects.validate(message);
	}, "exactly one contract");

	delete message.registry.second;
	message.registry.mandate.executor = "worker";

	message.recipient.title =
		"$:/temp/clerus/jobs/browser/message-new-owner";

	assert(messageEffects.validate(message).establishing);

	message.registry.mandate.temp = false;

	throws(function () {
		messageEffects.validate(message);
	}, "does not permit the recipient durability");
}

exports.run = function (tw) {
	var cases = [
		["schemas: registries and safe keys", testRegistries],
		["schemas: strict JSON boundary", testJSONBoundary],
		["schemas: ephemeral job", testJob],
		["store: transitions, replay and conflicts", function () {
			testTransitions(tw);
		}],
		["store: snapshot isolation", function () {
			testSnapshotIsolation(tw);
		}],
		["job state: structural registry reading", testJobRegistryReading],
		["job state: conservative isolated projection", testJobProjection],
		["job state: projection follows the active branch", testJobProjectionBranches],
		["job state: execution header is not authorization", testExecutionHeader],
		["job state: addressed reading preserves source failures", testAddressedJobReading],
		["job state: public status permits partial interpretation", testPartialStatusReading],
		["job state: owner overlay isolates both inputs", testOwnerOverlayIsolation],
		["job state: owner overlay enforces structural boundaries", testOwnerOverlayBoundaries],
		["reaction services: shared lazy assembly", testReactionServiceAssembly],
		["execution contract: ordered completion checks", testExecutionCompletionContract],
		["execution contract: failure stops completion", testExecutionCompletionFailures],
		["reaction event: isolated deeply frozen context", testReactionEventPreparation],
		["reaction event: establishment and JSON boundaries", testEstablishingReactionEvent],
		["establishment input: unique isolated mandate and durability", testEstablishmentInput],
		["external pass: outer boundary owns collection", testExternalPassBoundaries],
		["external pass: execution and collection failures stay distinct", testExternalPassFailures],
		["accepted-plan protocol: version, isolation and accepted authority", testAcceptedPlanProtocol],
		["deferred protocol: body version and platform binding", testDeferredProtocol],
		["incident protocol: strict envelope and opaque diagnostics", testIncidentProtocol],
		["WAL envelope: version, kind and platform classification", testWalEnvelopeReading],
		["WAL envelope: required kind does not authorize custody", testRequiredWalEnvelope],
		["message protocol: founding contract checks preserve precedence", testEstablishingMessageContract],
	];

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