/*\
title: $:/plugins/clerus/tests/core/warrant-delegation.js
type: application/javascript
module-type: library
\*/

"use strict";

var Scheduler = require(
	"$:/plugins/clerus/core/scheduler.js"
).Scheduler;
var Store = require("$:/plugins/clerus/core/store.js").Store;

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
	var prefix = "$:/temp/clerus/jobs/" + platform + "/";

	var superior = prefix + "warrant-delegation-superior";
	var worker = prefix + "warrant-delegation-worker";
	var project = "Warrant Delegation Project";

	var publicSource = "Research/Public/Source";
	var privateSource = "Research/Private/Source";

	var sequence = 0;
	var receptions = 0;
	var rejectedAfterRevocation = 0;
	var createdTitle = null;

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

	write(superior, "warrant-superior", {
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

			discover: [{
				name: "sources",
				filters: ["[tag[Source]sort[title]]"]
			}],

			generate: [{
				name: "note",
				titlePrefix: "Research/",
				fields: {
					type: "text/plain",
					tags: "Source"
				},
				inputFields: ["text", "caption"]
			}],

			edit: [{
				name: "annotate",
				target: { titlePrefix: "Research/" },
				setFields: ["text", "research-summary"],
				removeFields: ["research-summary"]
			}]
		}
	});

	write(worker, "warrant-worker", {});

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: {},
			parts: {
				item: { task: {}, parts: {} }
			}
		})
	}));

	[publicSource, privateSource].forEach(function (title) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			"clerus-custody": platform,
			tags: "Source",
			text: "Original"
		}));
	});

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	function unchangedOnFailure(operation, fragment) {
		var before = JSON.stringify(store.snapshot());

		throws(operation, fragment);

		assert(
			JSON.stringify(store.snapshot()) === before,
			"Rejected operation changed the authoritative store"
		);
	}

	var handlers = {
		"warrant-superior": function (event, operational) {
			if (event.type === "delegate") {
				var outgoing = operational.outgoing();

				operational.get("access").narrow({
					binding: {
						project: project,
						role: ["item"],
						link: "10/1"
					},

					discover: [{
						name: "sources",
						filters: ["[prefix[Research/Public/]]"]
					}],

					generate: [{
						name: "note",
						titlePrefix: "Research/Public/Generated/",
						inputFields: ["text"]
					}],

					edit: [{
						name: "annotate",
						target: {
							titlePrefix: "Research/Public/"
						},
						setFields: ["research-summary"],
						removeFields: []
					}]
				}, outgoing, "access");

				/*
				The child is active before and after moving into the
				transactional registry. Transmission retains its parent.
				*/
				operational.move(
					"child",
					outgoing,
					"assignment"
				);

				/*
				Delegation has value semantics. Destroying the source
				warrant must not revoke its independently created result.
				*/
				operational.destroy("access");

				operational.get("subordinate").order(outgoing);
				return;
			}

			assert(
				event.type === "revoke" ||
				event.type === "replace"
			);

			var root = operational.get("root");

			root.revokePart("item");

			if (event.type === "replace") {
				root.createMission(
					"item",
					operational,
					"replacement"
				);
			}

			/*
			An empty official order asks the existing worker to check
			its retained documents after the authority change.
			*/
			operational.get("subordinate").order(
				operational.outgoing()
			);
		},

		"warrant-worker": function (event, operational, incoming) {
			assert(event.type === "order");

			if (incoming.keys().indexOf("access") !== -1) {
				receptions++;

				assert(
					operational.keys().join(",") === "charter"
				);

				var received = incoming.get("access");

				/*
				The binding works while its assignment is still incoming.
				Neither document has been implicitly filed.
				*/
				assert(received.inspect().active);
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

				assert(operational.get("access") === received);
				assert(!registry(superior).access);

				var access = operational.get("access");

				assert(
					access.select("sources").join(",") === publicSource
				);

				var source = access.capture(
					"sources",
					publicSource,
					operational,
					"source"
				);

				unchangedOnFailure(function () {
					access.capture(
						"sources",
						privateSource,
						operational,
						"private"
					);
				}, "outside warrant");

				unchangedOnFailure(function () {
					access.generate("note", {
						text: "Denied",
						caption: "Not delegated"
					}, operational, "denied");
				}, "not allowed");

				var generated = access.generate(
					"note",
					{ text: "Generated content" },
					operational,
					"generated"
				);

				createdTitle = registry(worker).generated;

				assert(
					createdTitle.indexOf(
						"Research/Public/Generated/"
					) === 0
				);

				assert(generated.text() === "Generated content");

				access.apply("annotate", source, {
					set: {
						"research-summary": "Source summary"
					}
				});

				access.apply("annotate", generated, {
					set: {
						"research-summary": "Generated summary"
					}
				});

				unchangedOnFailure(function () {
					access.apply("annotate", source, {
						set: { text: "Not delegated" }
					});
				}, "not allowed");

				unchangedOnFailure(function () {
					access.apply("annotate", source, {
						remove: ["research-summary"]
					});
				}, "not allowed");

				assert(source.text() === "Original");
				assert(
					source.field("research-summary") ===
						"Source summary"
				);

				assert(
					access.select("sources").indexOf(createdTitle) !== -1
				);

				return;
			}

			rejectedAfterRevocation++;

			assert(incoming.keys().length === 0);

			var retained = operational.get("access");

			assert(!retained.inspect().active);
			assert(!operational.get("mission").inspect().active);

			unchangedOnFailure(function () {
				retained.select("sources");
			});

			unchangedOnFailure(function () {
				retained.capture(
					"sources",
					publicSource,
					operational,
					"afterRevocation"
				);
			});

			unchangedOnFailure(function () {
				retained.generate(
					"note",
					{ text: "Denied" },
					operational,
					"afterRevocation"
				);
			});

			unchangedOnFailure(function () {
				retained.apply(
					"annotate",
					operational.get("source"),
					{
						set: {
							"research-summary": "Denied"
						}
					}
				);
			});

			/*
			Revocation does not retroactively consume acquired titles.
			*/
			assert(
				operational.get("source").text() === "Original"
			);

			assert(
				operational.get("generated").text() ===
					"Generated content"
			);
		}
	};

	var scheduler = new Scheduler({
		store: store,
		platform: platform,

		newId: function () {
			sequence++;

			return "warrant-delegation-" +
				String(sequence).padStart(12, "0");
		},

		readJobs: function () {
			return [superior, worker].map(function (title) {
				var tiddler = wiki.getTiddler(title);

				return {
					title: title,
					custody: tiddler.fields["clerus-custody"],
					registry: registry(title)
				};
			});
		},

		resolveExecutor: function (name) {
			return handlers[name];
		}
	});

	function dispatch(type) {
		var result = scheduler.dispatch(superior, { type: type });

		assert(
			result.errors.length === 0,
			JSON.stringify(result.errors)
		);

		assert(
			result.skipped.length === 0,
			JSON.stringify(result.skipped)
		);

		return result;
	}

	return {
		wiki: wiki,
		superior: superior,
		worker: worker,
		dispatch: dispatch,
		registry: registry,

		assertDelivered: function () {
			assert(receptions === 1);
			assert(!registry(superior).access);
			assert(!registry(superior).child);

			assert(registry(worker).mission.link === "10/1");
			assert(registry(worker).access.binding.link === "10/1");

			assert(
				wiki.getTiddler(privateSource).fields.text ===
					"Original"
			);

			assert(createdTitle);
			assert(
				wiki.getTiddler(createdTitle)
					.fields["research-summary"] ===
						"Generated summary"
			);
		},

		assertRevoked: function () {
			assert(rejectedAfterRevocation === 1);
			assert(registry(worker).access.binding.link === "10/1");
		}
	};
}

function testDelegation(tw) {
	var f = fixture(tw);

	f.dispatch("delegate");
	f.assertDelivered();
}

function testRevocation(tw) {
	var f = fixture(tw);

	f.dispatch("delegate");
	f.assertDelivered();

	f.dispatch("revoke");
	f.assertRevoked();

	assert(
		!Object.prototype.hasOwnProperty.call(
			f.registry(f.superior).root.children,
			"item"
		)
	);
}

function testReplacement(tw) {
	var f = fixture(tw);

	f.dispatch("delegate");
	f.assertDelivered();

	f.dispatch("replace");
	f.assertRevoked();

	assert(
		f.registry(f.superior).root.children.item === "10/2"
	);

	assert(
		f.registry(f.superior).replacement.link === "10/2"
	);

	assert(
		f.registry(f.worker).mission.link === "10/1"
	);
}

exports.run = function (tw) {
	var cases = [
		[
			"warrant delegation: all facets survive official transfer",
			testDelegation
		],
		[
			"warrant delegation: revocation stops authority but preserves titles",
			testRevocation
		],
		[
			"warrant delegation: replacement does not reactivate old warrants",
			testReplacement
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