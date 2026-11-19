/*\
title: $:/plugins/clerus/tests/core/warrant-generation-recovery.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var plannedReactions = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
var proposalWork = require(
	"$:/plugins/clerus/core/proposal-work.js"
);
var continuations = require(
	"$:/plugins/clerus/core/continuations.js"
);
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

function fixture(tw, generatedFirst) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";

	var owner = "$:/clerus/jobs/warrant-generation-recovery";
	var authority = "$:/clerus/jobs/warrant-generation-authority";
	var project = "Warrant Generation Recovery Project";
	var generated = "Generated/recovery-item";

	var handlerCalls = 0;
	var generationIds = 0;
	var infrastructureIds = 0;
	var resolverCalls = 0;

	function newInfrastructureId() {
		infrastructureIds++;

		return "warrant-recovery-" +
			String(infrastructureIds).padStart(12, "0");
	}

	function addJob(title, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "warrant-generation-recovery",
			text: JSON.stringify(registry)
		}));
	}

	addJob(authority, {
		charter: { form: "charter", status: {} },

		root: {
			form: "mission",
			project: project,
			role: [],
			link: "10",
			issued: "1",
			children: {
				item: "10/1"
			}
		},

		child: {
			form: "mission",
			project: project,
			role: ["item"],
			link: "10/1",
			issued: "0",
			children: {}
		}
	});

	addJob(owner, {
		charter: { form: "charter", status: {} },

		access: {
			form: "warrant",

			binding: {
				project: project,
				role: ["item"],
				link: "10/1"
			},

			discover: [],

			generate: [{
				name: "note",
				titlePrefix: "Generated/",
				fields: {
					type: "text/plain"
				},
				inputFields: ["text"]
			}],

			edit: []
		}
	});

	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var proposal = plannedReactions.execute({
		store: store,
		title: owner,
		platform: platform,
		event: { type: "test" },

		newId: function () {
			generationIds++;

			assert(
				generationIds === 1,
				"Generation identity must only be allocated once"
			);

			return "recovery-item";
		},

		handler: function (event, operational) {
			handlerCalls++;

			operational.get("access").generate(
				"note",
				{ text: "Accepted content" },
				operational,
				"created"
			);
		}
	});

	var work = proposalWork.convert(
		proposal,
		newInfrastructureId(),
		platform
	);

	assert(work.transitions.length === 2);

	/*
	Order is explicitly varied before acceptance.
	We do not depend on title sorting in proposal compilation.
	*/
	var firstTitle = generatedFirst ? generated : owner;

	work.transitions.sort(function (left, right) {
		if (left.title === right.title) {
			return 0;
		}

		return left.title === firstTitle ? -1 : 1;
	});

	assert(work.transitions[0].title === firstTitle);

	function manager() {
		return continuations.create({
			store: store,
			platform: platform,
			newId: newInfrastructureId
		});
	}

	var service = manager();
	var journal = service.accept(work);

	function freshRuntime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: newInfrastructureId,

			resolveExecutor: function () {
				resolverCalls++;

				throw new Error(
					"Material recovery must not resolve executors"
				);
			}
		});
	}

	function ownerRegistry() {
		return JSON.parse(wiki.getTiddler(owner).fields.text);
	}

	function restoreJournalCustody() {
		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(journal),
			{ "clerus-custody": platform }
		));
	}

	function assertComplete() {
		assert(ownerRegistry().created === generated);

		var tiddler = wiki.getTiddler(generated);

		assert(tiddler);
		assert(tiddler.fields.text === "Accepted content");
		assert(tiddler.fields["clerus-custody"] === platform);

		assert(!wiki.getTiddler(journal));
		assert(handlerCalls === 1);
		assert(generationIds === 1);
		assert(resolverCalls === 0);
	}

	function recoverSuccessfully() {
		var report = freshRuntime().recover();

		var entry = report.entries.find(function (candidate) {
			return candidate.title === journal;
		});

		assert(entry, "Recovery must report the accepted journal");
		assert(entry.status === "completed");
		assertComplete();

		return report;
	}

	return {
		wiki: wiki,
		store: store,
		owner: owner,
		authority: authority,
		generated: generated,
		journal: journal,
		platform: platform,
		firstTitle: firstTitle,
		service: service,
		freshRuntime: freshRuntime,
		ownerRegistry: ownerRegistry,
		restoreJournalCustody: restoreJournalCustody,
		assertComplete: assertComplete,
		recoverSuccessfully: recoverSuccessfully
	};
}

function testAcceptedBeforeWrites(tw) {
	var f = fixture(tw, false);

	assert(!f.wiki.getTiddler(f.generated));
	assert(!f.ownerRegistry().created);

	f.recoverSuccessfully();

	var before = JSON.stringify(f.store.snapshot());

	var repeated = f.freshRuntime().recover();

	assert(repeated.entries.length === 0);
	assert(JSON.stringify(f.store.snapshot()) === before);
	f.assertComplete();
}

function testInterruption(tw, generatedFirst, afterWrite) {
	var f = fixture(tw, generatedFirst);
	var originalApply = f.store.apply;
	var interrupted = false;
	var body = f.wiki.getTiddler(f.journal).fields.text;

	f.store.apply = function (effect) {
		if (
			effect.title === f.firstTitle &&
			!interrupted
		) {
			interrupted = true;

			if (afterWrite) {
				originalApply.call(this, effect);
			}

			throw new Error("Injected generation interruption");
		}

		return originalApply.call(this, effect);
	};

	try {
		throws(function () {
			f.service.resume(f.journal);
		}, "Injected generation interruption");
	} finally {
		f.store.apply = originalApply;
	}

	assert(interrupted);

	var paused = f.wiki.getTiddler(f.journal);

	assert(paused);
	assert(paused.fields["clerus-custody"] === "user");
	assert(paused.fields.text === body);

	assert(
		!!f.wiki.getTiddler(f.generated) ===
			(afterWrite && generatedFirst)
	);

	assert(
		!!f.ownerRegistry().created ===
			(afterWrite && !generatedFirst)
	);

	f.restoreJournalCustody();
	f.recoverSuccessfully();

	var repeated = f.freshRuntime().recover();

	assert(repeated.entries.length === 0);
	f.assertComplete();
}

function testBeforeFirstWrite(tw) {
	testInterruption(tw, false, false);
}

function testAfterOwnerWrite(tw) {
	testInterruption(tw, false, true);
}

function testAfterGeneratedWrite(tw) {
	testInterruption(tw, true, true);
}

function testConflictPreservesObligation(tw) {
	var f = fixture(tw, false);

	/*
	The title was absent when work was accepted, but is now occupied
	by unrelated state. Whole-package checking must prevent even
	the owner's earlier transition.
	*/
	f.wiki.addTiddler(new tw.Tiddler({
		title: f.generated,
		text: "Unrelated content"
	}));

	var report = f.freshRuntime().recover();

	var entry = report.entries.find(function (candidate) {
		return candidate.title === f.journal;
	});

	assert(entry);
	assert(entry.status === "failed");
	assert(!f.ownerRegistry().created);

	assert(
		f.wiki.getTiddler(f.generated).fields.text ===
			"Unrelated content"
	);

	var paused = f.wiki.getTiddler(f.journal);

	assert(paused);
	assert(paused.fields["clerus-custody"] === "user");
	assert(JSON.parse(paused.fields.text).work !== null);

	/*
	Explicit test repair removes the conflicting object.
	This is not an automatic rollback performed by Clerus.
	*/
	f.wiki.deleteTiddler(f.generated);
	f.restoreJournalCustody();

	f.recoverSuccessfully();
}

function testRevocationAfterAcceptance(tw) {
	var f = fixture(tw, false);

	/*
	Revoke the warrant's binding in a different job. The accepted
	owner transition remains untouched.
	*/
	var authority = f.wiki.getTiddler(f.authority);
	var registry = JSON.parse(authority.fields.text);

	delete registry.root.children.item;

	f.wiki.addTiddler(new tw.Tiddler(
		authority,
		{ text: JSON.stringify(registry) }
	));

	f.recoverSuccessfully();

	var after = JSON.parse(
		f.wiki.getTiddler(f.authority).fields.text
	);

	assert(!after.root.children.item);
	assert(after.child.link === "10/1");
}

exports.run = function (tw) {
	var cases = [
		[
			"generation recovery: accepted work needs no handler replay",
			testAcceptedBeforeWrites
		],
		[
			"generation recovery: interruption before the first write",
			testBeforeFirstWrite
		],
		[
			"generation recovery: owner-first partial materialization",
			testAfterOwnerWrite
		],
		[
			"generation recovery: generated-first partial materialization",
			testAfterGeneratedWrite
		],
		[
			"generation recovery: conflict preserves the obligation",
			testConflictPreservesObligation
		],
		[
			"generation recovery: later revocation does not cancel accepted work",
			testRevocationAfterAcceptance
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