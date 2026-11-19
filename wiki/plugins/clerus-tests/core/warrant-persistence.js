/*\
title: $:/plugins/clerus/tests/core/warrant-persistence.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var planned = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
var proposalWork = require(
	"$:/plugins/clerus/core/proposal-work.js"
);
var retention = require("$:/plugins/clerus/core/retention.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";

	var superior = "$:/clerus/jobs/warrant-persistence-superior";
	var worker = "$:/clerus/jobs/warrant-persistence-worker";
	var project = "Warrant Persistence Project";

	var sequence = 0;
	var senderCalls = 0;
	var receiverCalls = 0;
	var rejected = 0;
	var generated = null;

	function newId() {
		sequence++;

		return "warrant-persistence-" +
			String(sequence).padStart(12, "0");
	}

	function registry(title) {
		return JSON.parse(wiki.getTiddler(title).fields.text);
	}

	function write(title, executor, documents) {
		documents.charter = {
			form: "charter",
			status: {}
		};

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			text: JSON.stringify(documents)
		}));
	}

	write(superior, "warrant-persistence-superior", {
		root: {
			form: "mission",
			project: project,
			role: [],
			link: "10",
			issued: "1",
			children: { item: "10/1" }
		},

		child: {
			form: "mission",
			project: project,
			role: ["item"],
			link: "10/1",
			issued: "0",
			children: {}
		},

		subordinate: worker,

		access: {
			form: "warrant",

			binding: {
				project: project,
				role: [],
				link: "10"
			},

			discover: [],

			generate: [{
				name: "note",
				titlePrefix: "Research/",
				fields: { type: "text/plain" },
				inputFields: ["text"]
			}],

			edit: [{
				name: "annotate",
				target: { titlePrefix: "Research/" },
				setFields: ["research-summary"],
				removeFields: []
			}]
		}
	});

	write(worker, "warrant-persistence-worker", {});

	var handlers = {
		"warrant-persistence-superior": function (
			event,
			operational
		) {
			assert(event.type === "delegate");
			senderCalls++;

			var outgoing = operational.outgoing();

			operational.get("access").narrow({
				binding: {
					project: project,
					role: ["item"],
					link: "10/1"
				},

				generate: [{
					name: "note",
					titlePrefix: "Research/Delegated/"
				}],

				edit: [{
					name: "annotate",
					target: {
						titlePrefix: "Research/Delegated/"
					}
				}]
			}, outgoing, "access");

			operational.move(
				"child",
				outgoing,
				"assignment"
			);

			operational.get("subordinate").order(outgoing);
		},

		"warrant-persistence-worker": function (
			event,
			operational,
			incoming
		) {
			assert(event.type === "order");
			receiverCalls++;

			assert(operational.keys().join(",") === "charter");

			var access = incoming.get("access");

			if (!access.inspect().active) {
				rejected++;

				/*
				Revocation does not consume incoming documents.
				Dispose of both explicitly.
				*/
				incoming.destroy("access");
				incoming.destroy("assignment");

				operational.get("charter").setStatus({
					rejected: true
				});

				return;
			}

			assert(incoming.get("assignment").inspect().active);

			incoming.move(
				"assignment",
				operational,
				"mission"
			);

			incoming.move(
				"access",
				operational,
				"access"
			);

			var created = access.generate(
				"note",
				{ text: "Persistent content" },
				operational,
				"created"
			);

			access.apply("annotate", created, {
				set: {
					"research-summary": "Persistent summary"
				}
			});
		}
	};

	function createRuntime() {
		return new Runtime({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: newId,

			resolveExecutor: function (name) {
				return handlers[name];
			}
		});
	}

	var runtime = createRuntime();

	function prepare() {
		var proposal = planned.execute({
			store: runtime.store,
			title: superior,
			platform: platform,
			event: { type: "delegate" },
			newId: newId,
			handler: handlers["warrant-persistence-superior"]
		});

		return runtime.continuations.accept(
			proposalWork.convert(
				proposal,
				newId(),
				platform
			)
		);
	}

	function assertCompleted(journal) {
		assert(senderCalls === 1);
		assert(receiverCalls === 1);
		assert(rejected === 0);
		assert(!wiki.getTiddler(journal));

		var documents = registry(worker);

		assert(documents.mission.link === "10/1");
		assert(documents.access.binding.link === "10/1");

		generated = documents.created;

		assert(
			typeof generated === "string" &&
			generated.indexOf("Research/Delegated/") === 0
		);

		var tiddler = wiki.getTiddler(generated);

		assert(tiddler);
		assert(tiddler.fields.text === "Persistent content");
		assert(
			tiddler.fields["research-summary"] ===
				"Persistent summary"
		);
		assert(tiddler.fields["clerus-custody"] === platform);
	}

	return {
		wiki: wiki,
		platform: platform,
		superior: superior,
		worker: worker,
		runtime: runtime,
		createRuntime: createRuntime,
		registry: registry,
		prepare: prepare,
		assertCompleted: assertCompleted,

		assertNotDelivered: function () {
			assert(senderCalls === 1);
			assert(receiverCalls === 0);
		},

		assertReceivedOnce: function () {
			assert(senderCalls === 1);
			assert(receiverCalls === 1);
		},

		assertRejected: function (journal) {
			assert(senderCalls === 1);
			assert(receiverCalls === 1);
			assert(rejected === 1);
			assert(!wiki.getTiddler(journal));

			var documents = registry(worker);

			assert(documents.charter.status.rejected === true);
			assert(!documents.access);
			assert(!documents.mission);
			assert(!documents.created);

			var generatedTitles = [];

			wiki.each(function (tiddler, title) {
				if (title.indexOf("Research/Delegated/") === 0) {
					generatedTitles.push(title);
				}
			});

			assert(generatedTitles.length === 0);
		}
	};
}

function assertNoDeliveryErrors(report) {
	assert(
		report.errors.length === 0,
		JSON.stringify(report.errors)
	);

	assert(report.remaining === 0);
}

function testAcceptedOrderSurvivesRestart(tw) {
	var f = fixture(tw);
	var journal = f.prepare();

	f.assertNotDelivered();

	var restarted = f.createRuntime();
	var recovered = restarted.recover();

	var entry = recovered.entries.find(function (candidate) {
		return candidate.title === journal;
	});

	assert(
		entry,
		"Recovery entry is missing: " + JSON.stringify(recovered)
	);

	assert(
		entry.status === "pending",
		"Unexpected recovery result: " + JSON.stringify(entry)
	);

	assert(
		JSON.parse(
			f.wiki.getTiddler(journal).fields.text
		).work === null
	);

	/*
	Recovery materializes and publishes the accepted order,
	but does not call its recipient.
	*/
	f.assertNotDelivered();

	assert(
		restarted.continuations.pending(journal).length === 1
	);

	assertNoDeliveryErrors(restarted.drainMessages());
	f.assertCompleted(journal);

	var repeated = f.createRuntime();

	repeated.recover();
	assertNoDeliveryErrors(repeated.drainMessages());

	f.assertCompleted(journal);
}

function testInterruptedRecipientMaterialization(tw) {
	var f = fixture(tw);
	var journal = f.prepare();

	/*
	Finish the sender's work without delivering the order yet.
	*/
	f.runtime.continuations.resume(journal);

	var originalApply = f.runtime.store.apply;
	var interrupted = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (
			effect.title === f.worker &&
			!interrupted
		) {
			interrupted = true;

			throw new Error(
				"Interrupted warrant recipient materialization"
			);
		}

		return result;
	};

	var delivery;

	try {
		delivery = f.runtime.drainMessages();
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(interrupted);
	f.assertReceivedOnce();

	assert(delivery.errors.length === 1);
	assert(
		delivery.errors[0].result.phase === "materialization"
	);

	var paused = f.wiki.getTiddler(journal);
	var record = JSON.parse(paused.fields.text);

	assert(paused.fields["clerus-custody"] === "user");
	assert(record.work !== null);
	assert(record.work.blocks.indexOf(f.worker) !== -1);

	/*
	The worker registry has been written, but ordinary tiddler
	creation comes later in the compiled title order.
	*/
	var created = f.registry(f.worker).created;

	assert(typeof created === "string");
	assert(!f.wiki.getTiddler(created));

	f.wiki.addTiddler(new tw.Tiddler(paused, {
		"clerus-custody": f.platform
	}));

	var restarted = f.createRuntime();

	restarted.recover();

	/*
	Accepted consequences finish without repeating the receiver.
	*/
	f.assertCompleted(journal);
	assertNoDeliveryErrors(restarted.drainMessages());
	f.assertCompleted(journal);
}

function testRevokedWaitingOrder(tw) {
	var f = fixture(tw);
	var journal = f.prepare();

	f.runtime.continuations.resume(journal);
	f.assertNotDelivered();

	assert(
		f.runtime.continuations.pending(journal).length === 1
	);

	/*
	Explicit administrative fixture intervention while delivery waits.
	Using runtime.dispatch() here would also drain the waiting order,
	so this test changes the authoritative parent document directly.
	*/
	var current = f.wiki.getTiddler(f.superior);
	var documents = JSON.parse(current.fields.text);

	delete documents.root.children.item;

	f.wiki.addTiddler(new tw.Tiddler(
		current,
		{ text: JSON.stringify(documents) }
	));

	var restarted = f.createRuntime();

	assertNoDeliveryErrors(restarted.drainMessages());
	f.assertRejected(journal);
}

function testBindingDoesNotCreateRetention() {
	var holder = "$:/clerus/jobs/warrant-retention-holder";
	var mentioned = "$:/clerus/jobs/warrant-retention-mentioned";

	var view = retention.evaluate({
		jobs: [
			{
				title: holder,
				custody: "node",
				registry: {
					charter: { form: "charter", status: {} },

					access: {
						form: "warrant",

						/*
						A job-shaped string nested inside a binding
						is not a document-title organizational link.
						*/
						binding: {
							project: mentioned,
							role: [],
							link: "1"
						},

						discover: [],
						generate: [],
						edit: []
					}
				}
			},
			{
				title: mentioned,
				custody: "node",
				registry: {
					charter: { form: "charter", status: {} }
				}
			}
		],
		tiddlers: []
	});

	assert(view.complete);
	assert(view.valid);
	assert(view.retained.length === 0);
	assert(view.unretained.indexOf(holder) !== -1);
	assert(view.unretained.indexOf(mentioned) !== -1);
	assert(view.candidates.length === 2);
}

exports.run = function (tw) {
	var cases = [
		[
			"warrant persistence: accepted order survives restart",
			testAcceptedOrderSurvivesRestart
		],
		[
			"warrant persistence: recipient consequences resume without replay",
			testInterruptedRecipientMaterialization
		],
		[
			"warrant persistence: revoked waiting input is explicitly disposed",
			testRevokedWaitingOrder
		],
		[
			"warrant persistence: binding does not create retention",
			testBindingDoesNotCreateRetention
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