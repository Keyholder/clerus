/*\
title: $:/plugins/clerus/tests/core/continuation-repair.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var events = require("$:/plugins/clerus/core/event-schema.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";

	var target = "$:/clerus/jobs/repair-target";
	var reference = "$:/clerus/jobs/repair-reference";

	var originalId = "repair-original-event-0001";
	var sequence = 0;
	var attempts = [];
	var resumptions = 0;

	function writeJob(title, executor) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify({
				charter: {
					form: "charter",
					status: {}
				}
			})
		}));
	}

	writeJob(target, "repair-target");
	writeJob(reference, "repair-reference");

	function createRuntime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,

			newId: function () {
				sequence++;

				return "repair-generated-" +
					String(sequence).padStart(12, "0");
			},

			resolveExecutor: function (name) {
				if (name !== "repair-target") {
					return function () {};
				}

				return function (event, operational, incoming) {
					if (event.type === "suspended") {
						return;
					}

					if (event.type === "resumed") {
						resumptions++;
						return;
					}

					assert(event.type === "order");

					attempts.push(event.id);

					if (attempts.length === 1) {
						operational.get("charter").setStatus({
							phase: "rejected-proposal"
						});

						throw new Error(
							"First attempt deliberately rejected"
						);
					}

					incoming.destroy("reference");
					incoming.move("input", operational, "received");

					operational.get("charter").setStatus({
						phase: "received"
					});
				};
			}
		});
	}

	var runtime = createRuntime();

	var event = {
		kind: "delivery",
		recipient: {
			title: target,
			executor: "repair-target"
		},
		type: "order",
		registry: {
			reference: reference,
			input: {
				form: "memo",
				data: 42
			}
		}
	};

	var journal = runtime.continuations.accept({
		version: 2,
		id: "repair-initial-work-00001",
		checks: [],
		transitions: [],
		blocks: [],
		emits: [{
			id: originalId,
			event: event
		}]
	});

	runtime.recover();
	runtime.drainFlows();

	/*
		Everything below models user edits through ordinary TW5
		writes. No privileged manager mutation is used.
	*/
	function editJournal(change, custody) {
		var current = wiki.getTiddler(journal);
		var record = JSON.parse(current.fields.text);

		change(record);

		wiki.addTiddler(new tw.Tiddler(current, {
			"clerus-custody": custody || "user",
			text: JSON.stringify(record)
		}));
	}

	function restoreJobCustody() {
		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(target),
			{ "clerus-custody": platform }
		));
	}

	return {
		wiki: wiki,
		platform: platform,
		runtime: runtime,
		restart: createRuntime,
		target: target,
		reference: reference,
		journal: journal,
		originalId: originalId,
		attempts: attempts,
		editJournal: editJournal,
		restoreJobCustody: restoreJobCustody,

		resumptions: function () {
			return resumptions;
		},

		record: function () {
			return JSON.parse(wiki.getTiddlerText(journal));
		},

		registry: function () {
			return JSON.parse(wiki.getTiddlerText(target));
		}
	};
}

function restoreRecipient(f, runtime) {
	f.restoreJobCustody();

	var resumed = runtime.resume(f.target);

	assert(resumed.status === "completed");
	assert(f.resumptions() === 1);
	assert(f.attempts.length === 1);
}

function testInitialFailurePreservesObligation(tw) {
	var f = fixture(tw);
	var record = f.record();

	assert(f.attempts.length === 1);
	assert(f.attempts[0] === f.originalId);

	assert(record.work === null);
	assert(record.events[f.originalId].mode === "paused");
	assert(
		record.events[f.originalId].event.registry.input.data === 42
	);
	assert(
		record.events[f.originalId].event.registry.reference ===
			f.reference
	);

	assert(record.diagnostics.length === 1);
	assert(record.diagnostics[0].event === f.originalId);

	assert(
		f.wiki.getTiddler(f.journal).fields["clerus-custody"] ===
			"user"
	);
	assert(
		f.wiki.getTiddler(f.target).fields["clerus-custody"] ===
			"user"
	);

	assert(
		f.registry().charter.status.phase !== "rejected-proposal"
	);

	var view = f.runtime.inspect().retention;

	assert(view.complete);

	[f.target, f.reference].forEach(function (title) {
		assert(view.retained.some(function (entry) {
			return entry.title === title;
		}));
	});
}

function testSameEventCanBeRetriedAfterRepair(tw) {
	var f = fixture(tw);
	var fingerprint = f.record().evidence.identities[f.originalId];
	var restarted = f.restart();

	restoreRecipient(f, restarted);

	/*
		Restoring the job does not resume its paused event.
	*/
	restarted.drainFlows();
	assert(f.attempts.length === 1);

	f.editJournal(function (record) {
		record.events[f.originalId].mode = "ready";
	}, f.platform);

	restarted.recover();

	assert(f.attempts.length === 1);
	assert(
		f.record().evidence.identities[f.originalId] === fingerprint
	);

	restarted.drainFlows();

	assert(f.attempts.length === 2);
	assert(f.attempts[0] === f.attempts[1]);
	assert(f.registry().received.data === 42);
	assert(!f.wiki.tiddlerExists(f.journal));

	restarted.drainFlows();
	assert(f.attempts.length === 2);
}

function testReadyEventWaitsForRecipientResumption(tw) {
	var f = fixture(tw);

	/*
		Assign the job back to this platform without yet delivering
		the mandatory resumed event.
	*/
	f.restoreJobCustody();

	f.editJournal(function (record) {
		record.events[f.originalId].mode = "ready";
	}, f.platform);

	var report = f.runtime.drainFlows();
	var blocked = [];

	report.continuations.forEach(function (pass) {
		blocked = blocked.concat(pass.blocked);
	});

	assert(blocked.some(function (entry) {
		return (
			entry.title === f.journal &&
			entry.eventId === f.originalId &&
			entry.reason === "resumption-required"
		);
	}));

	assert(f.attempts.length === 1);
	assert(f.record().events[f.originalId].mode === "ready");

	var resumed = f.runtime.resume(f.target);

	assert(resumed.status === "completed");
	assert(f.resumptions() === 1);

	/*
		runtime.resume() also drains official work, so the ready
		event may already have completed in that pass.
	*/
	assert(f.attempts.length === 2);
	assert(!f.wiki.tiddlerExists(f.journal));
}

function testChangedContentCannotKeepIdentity(tw) {
	var f = fixture(tw);
	var restarted = f.restart();

	f.editJournal(function (record) {
		record.events[f.originalId].event.registry.input.data = 99;
		record.events[f.originalId].mode = "ready";
	}, f.platform);

	var report = restarted.recover();

	assert(report.entries.some(function (entry) {
		return (
			entry.title === f.journal &&
			entry.status === "failed" &&
			entry.error.indexOf(
				"Waiting event identity is not registered"
			) !== -1
		);
	}));

	assert(f.attempts.length === 1);

	var journal = f.wiki.getTiddler(f.journal);

	assert(journal.fields["clerus-custody"] === "user");

	/*
		Failed reading preserves the user's body, rather than
		silently replacing the modified content.
	*/
	assert(
		JSON.parse(journal.fields.text)
			.events[f.originalId].event.registry.input.data === 99
	);
}

function testReplacementUsesNewIdentity(tw) {
	var f = fixture(tw);
	var restarted = f.restart();
	var replacementId = "repair-replacement-event-01";

	restoreRecipient(f, restarted);

	f.editJournal(function (record) {
		var event = record.events[f.originalId].event;

		event.registry.input.data = 99;

		delete record.events[f.originalId];

		record.events[replacementId] = {
			mode: "ready",
			event: event
		};

		record.evidence.identities[replacementId] =
			events.fingerprint(event);

		/*
			The original fingerprint and diagnostic may remain.
			Neither constitutes another pending event.
		*/
	}, f.platform);

	restarted.recover();
	restarted.drainFlows();

	assert(f.attempts.length === 2);
	assert(f.attempts[0] === f.originalId);
	assert(f.attempts[1] === replacementId);

	assert(f.registry().received.data === 99);
	assert(!f.wiki.tiddlerExists(f.journal));
}

function testTerminationLeavesOnlyNonRetainingHistory(tw) {
	var f = fixture(tw);

	f.editJournal(function (record) {
		var historical = record.events[f.originalId].event;

		record.diagnostics.push({
			event: f.originalId,
			action: "user-terminated",
			snapshot: historical
		});

		delete record.events[f.originalId];
	});

	var record = f.record();

	assert(Object.keys(record.events).length === 0);
	assert(record.evidence.identities[f.originalId]);
	assert(record.diagnostics.length === 2);

	var view = f.runtime.inspect().retention;

	assert(view.complete);
	assert(view.valid);
	assert(view.candidates.indexOf(f.target) !== -1);
	assert(view.candidates.indexOf(f.reference) !== -1);

	assert(!view.retained.some(function (entry) {
		return (
			entry.title === f.target ||
			entry.title === f.reference
		);
	}));

	/*
		The historical journal remains under user custody.
		Reading the perspective does not delete it.
	*/
	assert(f.wiki.tiddlerExists(f.journal));
	assert(f.attempts.length === 1);
}

function testAdministrativeResolutionAcceptsRetainedDocuments(tw) {
	var f = fixture(tw);

	/*
	Retaining a document requires real operational custody.
	Resumption does not retry the user-owned paused event.
	*/
	restoreRecipient(f, f.runtime);

	var decision = {
		id: "repair-resolution-retain-0001",
		operations: [
			{ operation: "destroy", key: "reference" },
			{
				operation: "retain",
				key: "input",
				destinationKey: "recovered"
			}
		]
	};

	var fingerprint = f.record().evidence.identities[f.originalId];
	var registryBefore = f.wiki.getTiddlerText(f.target);

	var result = f.runtime.resolveEvent(
		f.journal,
		f.originalId,
		decision
	);

	assert(result.status === "accepted");
	assert(f.attempts.length === 1);

	var accepted = f.record();

	assert(!Object.prototype.hasOwnProperty.call(
		accepted.events,
		f.originalId
	));
	assert(accepted.work !== null);
	assert(accepted.work.id === decision.id);
	assert(
		accepted.evidence.identities[f.originalId] === fingerprint
	);
	assert(
		f.wiki.getTiddlerText(f.target) === registryBefore
	);
	assert(
		f.wiki.getTiddler(f.journal)
			.fields["clerus-custody"] === "user"
	);

	var body = f.wiki.getTiddlerText(f.journal);

	result = f.runtime.resolveEvent(
		f.journal,
		f.originalId,
		decision
	);

	assert(result.status === "already-accepted");
	assert(f.wiki.getTiddlerText(f.journal) === body);

	/*
	The accepted plan is authoritative but remains held.
	*/
	f.runtime.recover();

	assert(f.wiki.getTiddlerText(f.target) === registryBefore);

	f.editJournal(function () {}, f.platform);

	var restarted = f.restart();
	restarted.recover();

	assert(f.attempts.length === 1);
	assert(f.registry().recovered.data === 42);

	var history = f.record();

	assert(history.work === null);
	assert(Object.keys(history.events).length === 0);
	assert(history.diagnostics.some(function (entry) {
		return entry.action === "user-resolved" &&
			entry.decision.id === decision.id;
	}));
	assert(
		f.wiki.getTiddler(f.journal)
			.fields["clerus-custody"] === "user"
	);
}

function testAdministrativeResolutionCanDestroyWithoutOwnerWrite(tw) {
	var f = fixture(tw);
	var ownerBefore = JSON.stringify(
		f.wiki.getTiddler(f.target).fields
	);

	var result = f.runtime.resolveEvent(
		f.journal,
		f.originalId,
		{
			id: "repair-resolution-destroy-0001",
			operations: [
				{ operation: "destroy", key: "reference" },
				{ operation: "destroy", key: "input" }
			]
		}
	);

	assert(result.status === "accepted");
	assert(f.attempts.length === 1);

	var record = f.record();

	/*
	Consumption is recorded even without material transitions.
	The failed recipient is neither modified nor resumed.
	*/
	assert(record.work === null);
	assert(Object.keys(record.events).length === 0);
	assert(
		JSON.stringify(f.wiki.getTiddler(f.target).fields) ===
			ownerBefore
	);
	assert(
		f.wiki.getTiddler(f.target)
			.fields["clerus-suspended"] === "yes"
	);

	var view = f.runtime.inspect().retention;

	assert(view.complete);
	assert(view.valid);
	assert(!view.retained.some(function (entry) {
		return entry.title === f.target ||
			entry.title === f.reference;
	}));
}

function testAdministrativeResolutionRejectsPartialDisposition(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddlerText(f.journal);
	var ownerBefore = f.wiki.getTiddlerText(f.target);
	var caught = null;

	try {
		f.runtime.resolveEvent(
			f.journal,
			f.originalId,
			{
				id: "repair-resolution-partial-0001",
				operations: [
					{ operation: "destroy", key: "reference" }
				]
			}
		);
	} catch (error) {
		caught = error;
	}

	assert(caught);
	assert(
		String(caught.message).indexOf(
			"explicitly cover every incoming document"
		) !== -1
	);
	assert(f.wiki.getTiddlerText(f.journal) === before);
	assert(f.wiki.getTiddlerText(f.target) === ownerBefore);
	assert(f.attempts.length === 1);
	assert(!f.runtime.executing);
}

function testAdministrativeResolutionDoesNotGrantCustody(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddlerText(f.journal);
	var ownerBefore = JSON.stringify(
		f.wiki.getTiddler(f.target).fields
	);
	var caught = null;

	try {
		f.runtime.resolveEvent(
			f.journal,
			f.originalId,
			{
				id: "repair-resolution-no-custody-0001",
				operations: [
					{ operation: "destroy", key: "reference" },
					{
						operation: "retain",
						key: "input",
						destinationKey: "recovered"
					}
				]
			}
		);
	} catch (error) {
		caught = error;
	}

	assert(caught);
	assert(
		String(caught.message).indexOf("not writable") !== -1
	);
	assert(f.wiki.getTiddlerText(f.journal) === before);
	assert(
		JSON.stringify(f.wiki.getTiddler(f.target).fields) ===
			ownerBefore
	);
	assert(f.attempts.length === 1);
	assert(!f.runtime.executing);
}

exports.run = function (tw) {
	var cases = [
		["failure preserves the authoritative event", testInitialFailurePreservesObligation],
		["repair retries the same event identity", testSameEventCanBeRetriedAfterRepair],
		["ready event waits for recipient resumption", testReadyEventWaitsForRecipientResumption],
		["changed content cannot keep event identity", testChangedContentCannotKeepIdentity],
		["replacement uses a new event identity", testReplacementUsesNewIdentity],
		["terminated event leaves non-retaining history", testTerminationLeavesOnlyNonRetainingHistory],
		["administrative resolution accepts retained documents without invoking executor", testAdministrativeResolutionAcceptsRetainedDocuments],
		["administrative resolution records destruction without owner write", testAdministrativeResolutionCanDestroyWithoutOwnerWrite],
		["administrative resolution rejects incomplete disposition", testAdministrativeResolutionRejectsPartialDisposition],
		["administrative resolution does not grant operational custody", testAdministrativeResolutionDoesNotGrantCustody]
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