/*\
title: $:/plugins/clerus/tests/core/warrant-editing-protocols.js
type: application/javascript
module-type: library
\*/

"use strict";

var reactions = require("$:/plugins/clerus/core/reaction.js");
var planned = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
var proposalWork = require(
	"$:/plugins/clerus/core/proposal-work.js"
);
var continuations = require(
	"$:/plugins/clerus/core/continuations.js"
);
var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var jobState = require("$:/plugins/clerus/core/job-state.js");
var stores = require("$:/plugins/clerus/core/store.js");

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

	var owner = "$:/clerus/jobs/warrant-editing-protocol-owner";
	var authority = "$:/clerus/jobs/warrant-editing-protocol-authority";
	var blocker = "$:/clerus/jobs/warrant-editing-protocol-blocker";

	var ephemeral =
		"$:/temp/clerus/jobs/" + platform +
		"/warrant-editing-protocol-worker";

	var target = "Research/Protocol Source";
	var project = "Warrant Editing Protocol Project";

	var sequence = 0;
	var handlerCalls = 0;
	var resolverCalls = 0;

	function newId() {
		sequence++;

		return "editing-protocol-" +
			String(sequence).padStart(12, "0");
	}

	function addJob(title, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "warrant-editing-protocol",
			text: JSON.stringify(registry)
		}));
	}

	function workerRegistry() {
		return {
			charter: { form: "charter", status: {} },
			source: target,
			access: {
				form: "warrant",

				binding: {
					project: project,
					role: [],
					link: "1"
				},

				discover: [],
				generate: [],

				edit: [{
					name: "edit",
					target: { titlePrefix: "Research/" },
					setFields: ["text"],
					removeFields: []
				}]
			}
		};
	}

	addJob(owner, workerRegistry());
	addJob(ephemeral, workerRegistry());

	addJob(blocker, {
		charter: { form: "charter", status: {} }
	});

	addJob(authority, {
		charter: { form: "charter", status: {} },

		root: {
			form: "mission",
			project: project,
			role: [],
			link: "1",
			issued: "0",
			children: {}
		}
	});

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": platform,
		text: "Original"
	}));

	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	function readJobs() {
		return jobState.readJobs(function (visit) {
			wiki.each(function (tiddler, title) {
				visit(tiddler.fields, title);
			});
		});
	}

	function manager() {
		return continuations.create({
			store: store,
			platform: platform,
			newId: newId
		});
	}

	function prepareEdit() {
		return planned.execute({
			store: store,
			title: owner,
			platform: platform,
			event: { type: "test" },

			handler: function (event, operational) {
				handlerCalls++;

				operational.get("access").apply(
					"edit",
					operational.get("source"),
					{ set: { text: "Accepted" } }
				);
			}
		});
	}

	function acceptProposal(proposal) {
		return manager().accept(proposalWork.convert(
			proposal,
			newId(),
			platform
		));
	}

	function restoreJournal(journal) {
		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(journal),
			{ "clerus-custody": platform }
		));
	}

	function revoke() {
		var current = wiki.getTiddler(authority);
		var registry = JSON.parse(current.fields.text);

		delete registry.root;

		wiki.addTiddler(new tw.Tiddler(
			current,
			{ text: JSON.stringify(registry) }
		));
	}

	function recover(journal) {
		var runtime = new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: newId,

			resolveExecutor: function () {
				resolverCalls++;

				throw new Error(
					"Material recovery must not resolve executors"
				);
			}
		});

		var report = runtime.recover();

		var entry = report.entries.find(function (candidate) {
			return candidate.title === journal;
		});

		assert(entry);
		assert(entry.status === "completed");
		assert(!wiki.getTiddler(journal));
		assert(wiki.getTiddler(target).fields.text === "Accepted");
		assert(handlerCalls === 1);
		assert(resolverCalls === 0);

		var repeated = runtime.recover();

		assert(repeated.entries.length === 0);
		assert(handlerCalls === 1);
		assert(resolverCalls === 0);
	}

	function assertEphemeralBlocked() {
		reactions.execute({
			store: store,
			title: ephemeral,
			platform: platform,
			event: { type: "test" },
			readJobs: readJobs,

			handler: function (event, operational) {
				var before = JSON.stringify(store.snapshot());

				throws(function () {
					operational.get("access").apply(
						"edit",
						operational.get("source"),
						{ set: { text: "Intrusion" } }
					);
				}, "blocked by accepted work");

				assert(
					JSON.stringify(store.snapshot()) === before
				);
			}
		});
	}

	return {
		wiki: wiki,
		store: store,
		target: target,
		owner: owner,
		blocker: blocker,
		platform: platform,
		newId: newId,
		manager: manager,
		prepareEdit: prepareEdit,
		acceptProposal: acceptProposal,
		restoreJournal: restoreJournal,
		revoke: revoke,
		recover: recover,
		assertEphemeralBlocked: assertEphemeralBlocked
	};
}

function testAcceptedWriteBlocksNewEdit(tw) {
	var f = fixture(tw);
	var journal = f.acceptProposal(f.prepareEdit());

	f.assertEphemeralBlocked();

	var before = JSON.stringify(f.store.snapshot());

	throws(function () {
		f.prepareEdit();
	}, "blocked by accepted work");

	assert(JSON.stringify(f.store.snapshot()) === before);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(journal),
		{ "clerus-custody": "user" }
	));

	f.assertEphemeralBlocked();

	f.restoreJournal(journal);
	f.manager().resume(journal);

	assert(f.wiki.getTiddler(f.target).fields.text === "Accepted");
}

function testAcceptedReadBlocksNewEdit(tw) {
	var f = fixture(tw);

	var proposal = planned.execute({
		store: f.store,
		title: f.blocker,
		platform: f.platform,
		event: { type: "test" },

		handler: function (event, operational) {
			operational.get("charter").setStatus({
				phase: "accepted"
			});
		}
	});

	var work = proposalWork.convert(
		proposal,
		f.newId(),
		f.platform
	);

	work.checks.push({
		title: f.target,
		state: f.store.read(f.target).fields
	});

	var journal = f.manager().accept(work);

	f.assertEphemeralBlocked();

	f.manager().resume(journal);

	assert(f.wiki.getTiddler(f.target).fields.text === "Original");
}

function testRevocationBeforePreparation(tw) {
	var f = fixture(tw);

	f.revoke();

	var before = JSON.stringify(f.store.snapshot());

	throws(function () {
		f.prepareEdit();
	});

	assert(JSON.stringify(f.store.snapshot()) === before);
	assert(f.wiki.getTiddler(f.target).fields.text === "Original");
}

function testRevocationAfterAcceptance(tw) {
	var f = fixture(tw);
	var journal = f.acceptProposal(f.prepareEdit());

	f.revoke();

	f.recover(journal);
}

function testInterruptedEdit(tw, afterWrite) {
	var f = fixture(tw);
	var journal = f.acceptProposal(f.prepareEdit());

	var originalApply = f.store.apply;
	var interrupted = false;

	f.store.apply = function (effect) {
		if (effect.title === f.target && !interrupted) {
			interrupted = true;

			if (afterWrite) {
				originalApply.call(this, effect);
			}

			throw new Error("Injected editing interruption");
		}

		return originalApply.call(this, effect);
	};

	try {
		throws(function () {
			f.manager().resume(journal);
		}, "Injected editing interruption");
	} finally {
		f.store.apply = originalApply;
	}

	assert(interrupted);

	assert(
		f.wiki.getTiddler(f.target).fields.text ===
			(afterWrite ? "Accepted" : "Original")
	);

	assert(
		f.wiki.getTiddler(journal).fields["clerus-custody"] === "user"
	);

	f.restoreJournal(journal);
	f.recover(journal);
}

function testBeforeWrite(tw) {
	testInterruptedEdit(tw, false);
}

function testAfterWrite(tw) {
	testInterruptedEdit(tw, true);
}

function testConflictAndExplicitRepair(tw) {
	var f = fixture(tw);
	var proposal = f.prepareEdit();

	var original = proposal.plan.effects.find(function (effect) {
		return effect.title === f.target;
	}).before;

	var journal = f.acceptProposal(proposal);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.target),
		{ text: "Intervention" }
	));

	throws(function () {
		f.manager().resume(journal);
	}, "conflict");

	assert(f.wiki.getTiddler(f.target).fields.text === "Intervention");

	var paused = f.wiki.getTiddler(journal);

	assert(paused.fields["clerus-custody"] === "user");
	assert(JSON.parse(paused.fields.text).work !== null);

	/*
	Explicit test repair restores the expected object.
	The runtime itself does not undo the intervention.
	*/
	f.wiki.addTiddler(new tw.Tiddler(original));
	f.restoreJournal(journal);

	f.recover(journal);
}

exports.run = function (tw) {
	var cases = [
		[
			"editing protocols: accepted write blocks new edits",
			testAcceptedWriteBlocksNewEdit
		],
		[
			"editing protocols: accepted read blocks new edits",
			testAcceptedReadBlocksNewEdit
		],
		[
			"editing protocols: revoked authority denies preparation",
			testRevocationBeforePreparation
		],
		[
			"editing protocols: revocation does not cancel accepted work",
			testRevocationAfterAcceptance
		],
		[
			"editing protocols: interruption before write is recoverable",
			testBeforeWrite
		],
		[
			"editing protocols: interruption after write is deduplicated",
			testAfterWrite
		],
		[
			"editing protocols: conflicts preserve work for explicit repair",
			testConflictAndExplicitRepair
		]
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