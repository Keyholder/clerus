/*\
title: $:/plugins/clerus/tests/core/warrant-bindings.js
type: application/javascript
module-type: library
\*/

"use strict";

var reactions = require("$:/plugins/clerus/core/reaction.js");
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

function clone(value) {
	return JSON.parse(JSON.stringify(value));
}

function binding(project, role, link) {
	return {
		project: project,
		role: role,
		link: link
	};
}

function warrant(bound) {
	var document = {
		form: "warrant",
		discover: [
			{
				name: "sources",
				filters: ["[tag[Source]]"]
			}
		],
		generate: [],
		edit: []
	};

	if (bound !== null) {
		document.binding = clone(bound);
	}

	return document;
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/";

	var titles = {
		root: prefix + "warrant-bindings-root",
		child: prefix + "warrant-bindings-child",
		observer: prefix + "warrant-bindings-observer"
	};

	var project = "Clerus Warrant Bindings Project";

	var rootBinding = binding(project, [], "10");
	var childBinding = binding(project, ["item"], "10/1");
	var leafBinding = binding(
		project,
		["item", "detail"],
		"10/1/1"
	);

	var rootMission = {
		form: "mission",
		project: project,
		role: [],
		link: "10",
		issued: "1",
		children: {
			item: "10/1"
		}
	};

	var childMission = {
		form: "mission",
		project: project,
		role: ["item"],
		link: "10/1",
		issued: "1",
		children: {
			detail: "10/1/1"
		}
	};

	var leafMission = {
		form: "mission",
		project: project,
		role: ["item", "detail"],
		link: "10/1/1",
		issued: "0",
		children: {}
	};

	function putJob(title, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": "warrant-bindings-test",
			text: JSON.stringify(registry)
		}));
	}

	function registry(title) {
		return JSON.parse(wiki.getTiddler(title).fields.text);
	}

	function replaceRegistry(title, value) {
		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(title),
			{ text: JSON.stringify(value) }
		));
	}

	putJob(titles.root, {
		charter: { form: "charter", status: {} },
		root: rootMission,
		subordinate: titles.child,
		rootWarrant: warrant(rootBinding),
		childWarrant: warrant(childBinding),
		leafWarrant: warrant(leafBinding)
	});

	/*
	The child holds both a child and its own immediate subassignment.
	The existing mission model explicitly permits coincident holders.
	*/
	putJob(titles.child, {
		charter: { form: "charter", status: {} },
		child: childMission,
		leaf: leafMission
	});

	/*
	The observer holds no missions and has no organizational
	relationship with their holders.
	*/
	putJob(titles.observer, {
		charter: { form: "charter", status: {} },
		rootWarrant: warrant(rootBinding),
		childWarrant: warrant(childBinding),
		leafWarrant: warrant(leafBinding),
		unboundWarrant: warrant(null)
	});

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: {},
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
		})
	}));

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	return {
		wiki: wiki,
		titles: titles,
		project: project,
		rootBinding: rootBinding,
		childBinding: childBinding,
		leafBinding: leafBinding,
		registry: registry,
		replaceRegistry: replaceRegistry,

		execute: function (title, handler, incoming) {
			return reactions.execute({
				store: store,
				title: title,
				platform: platform,
				event: { type: "test" },
				incoming: incoming,

				readJobs: function () {
					return Object.keys(titles).map(function (name) {
						var jobTitle = titles[name];
						var fields = wiki.getTiddler(jobTitle).fields;

						return {
							title: jobTitle,
							custody: fields["clerus-custody"],
							registry: registry(jobTitle)
						};
					});
				},

				handler: handler
			});
		}
	};
}

function testForeignHolder(tw) {
	var f = fixture(tw);

	f.execute(f.titles.observer, function (event, operational) {
		assert(operational.get("rootWarrant").inspect().active);
		assert(operational.get("childWarrant").inspect().active);
		assert(operational.get("leafWarrant").inspect().active);

		assert(operational.keys().indexOf("root") === -1);
		assert(operational.keys().indexOf("child") === -1);
	});
}

function testDescendantNarrowing(tw) {
	var f = fixture(tw);

	f.execute(f.titles.observer, function (event, operational) {
		var restricted = operational.get("rootWarrant").narrow({
			binding: f.leafBinding,
			discover: [
				{
					name: "sources",
					filters: ["[prefix[Public/]]"]
				}
			]
		}, operational, "restricted");

		assert(restricted.inspect().active);
		assert(
			restricted.declaration().binding.link === "10/1/1"
		);
		assert(
			restricted.declaration().discover[0].filters.length === 2
		);

		var newlyBound = operational.get("unboundWarrant").narrow({
			binding: f.childBinding
		}, operational, "newlyBound");

		assert(newlyBound.inspect().active);
		assert(newlyBound.declaration().binding.link === "10/1");
	});
}

function testForbiddenRebindingIsAtomic(tw) {
	var f = fixture(tw);

	f.execute(f.titles.observer, function (event, operational) {
		var child = operational.get("childWarrant");
		var before = f.wiki.getTiddler(f.titles.observer).fields.text;

		throws(function () {
			child.narrow({
				binding: f.rootBinding
			}, operational, "ancestor");
		}, "descendant mission");

		throws(function () {
			child.narrow({
				binding: binding(f.project, ["item"], "10/2")
			}, operational, "replacement");
		}, "descendant mission");

		throws(function () {
			child.narrow({
				binding: binding(
					"Another Project",
					["item", "detail"],
					"10/1/1"
				)
			}, operational, "otherProject");
		}, "descendant mission");

		assert(
			f.wiki.getTiddler(f.titles.observer).fields.text === before
		);
	});
}

function testRevocationWithinReaction(tw) {
	var f = fixture(tw);

	f.execute(f.titles.root, function (event, operational) {
		var child = operational.get("childWarrant");
		var leaf = operational.get("leafWarrant");

		assert(child.inspect().active);
		assert(leaf.inspect().active);

		operational.get("root").revokePart("item");

		assert(!child.inspect().active);
		assert(!leaf.inspect().active);
		assert(operational.get("rootWarrant").inspect().active);

		var before = f.wiki.getTiddler(f.titles.root).fields.text;

		throws(function () {
			child.narrow({
				binding: f.leafBinding
			}, operational, "denied");
		});

		assert(
			f.wiki.getTiddler(f.titles.root).fields.text === before
		);

		/*
		Attenuation without rebinding remains legal after revocation.
		It does not reactivate the resulting document.
		*/
		var inactive = child.narrow({
			discover: []
		}, operational, "inactive");

		assert(!inactive.inspect().active);
	});
}

function testReplacementDoesNotReactivate(tw) {
	var f = fixture(tw);

	f.execute(f.titles.root, function (event, operational) {
		var root = operational.get("root");

		root.revokePart("item");

		var replacement = root.createMission(
			"item",
			operational,
			"replacement"
		);

		assert(replacement.inspect().active);
		assert(!operational.get("childWarrant").inspect().active);
		assert(!operational.get("leafWarrant").inspect().active);

		var fresh = operational.get("rootWarrant").narrow({
			binding: binding(f.project, ["item"], "10/2")
		}, operational, "fresh");

		assert(fresh.inspect().active);
	});

	f.execute(f.titles.observer, function (event, operational) {
		assert(!operational.get("childWarrant").inspect().active);
		assert(!operational.get("leafWarrant").inspect().active);
	});
}

function testMissingProjectDoesNotRevoke(tw) {
	var f = fixture(tw);

	f.wiki.deleteTiddler(f.project);

	f.execute(f.titles.observer, function (event, operational) {
		assert(operational.get("rootWarrant").inspect().active);
		assert(operational.get("leafWarrant").inspect().active);

		var restricted = operational.get("rootWarrant").narrow({
			binding: f.leafBinding
		}, operational, "withoutProject");

		assert(restricted.inspect().active);
	});
}

function testTransactionalMission(tw) {
	var f = fixture(tw);

	/*
	Move the authoritative test setup's child assignment out of
	its former holder. It will be supplied as an incoming document
	to the observer.
	*/
	var childRegistry = f.registry(f.titles.child);
	var incomingMission = childRegistry.child;

	delete childRegistry.child;
	delete childRegistry.leaf;

	f.replaceRegistry(f.titles.child, childRegistry);

	var rootRegistry = f.registry(f.titles.root);
	rootRegistry.observer = f.titles.observer;
	f.replaceRegistry(f.titles.root, rootRegistry);

	f.execute(
		f.titles.observer,
		function (event, operational, incoming) {
			var access = operational.get("childWarrant");

			assert(access.inspect().active);
			assert(incoming.get("assignment").inspect().active);

			var outgoing = incoming.outgoing();

			incoming.move(
				"assignment",
				outgoing,
				"assignment"
			);

			assert(access.inspect().active);

			outgoing.destroy("assignment");

			assert(!access.inspect().active);
		},
		{ assignment: incomingMission }
	);
}

function testAmbiguousOwnerDeniesAuthority(tw) {
	var f = fixture(tw);

	var observer = f.registry(f.titles.observer);
	observer.duplicate = clone(
		f.registry(f.titles.child).child
	);

	f.replaceRegistry(f.titles.observer, observer);

	f.execute(f.titles.observer, function (event, operational) {
		assert(!operational.get("childWarrant").inspect().active);
		assert(!operational.get("leafWarrant").inspect().active);

		/*
		The duplicate child does not make the independent root
		assignment ambiguous.
		*/
		assert(operational.get("rootWarrant").inspect().active);
	});
}

exports.run = function (tw) {
	var cases = [
		["warrant bindings: assignment may belong to another job", testForeignHolder],
		["warrant bindings: narrowing follows active descendants", testDescendantNarrowing],
		["warrant bindings: forbidden rebinding is atomic", testForbiddenRebindingIsAtomic],
		["warrant bindings: revocation is visible within the reaction", testRevocationWithinReaction],
		["warrant bindings: replacement does not reactivate old authority", testReplacementDoesNotReactivate],
		["warrant bindings: project availability is independent", testMissingProjectDoesNotRevoke],
		["warrant bindings: transactional assignments participate", testTransactionalMission],
		["warrant bindings: ambiguous ownership denies authority", testAmbiguousOwnerDeniesAuthority]
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