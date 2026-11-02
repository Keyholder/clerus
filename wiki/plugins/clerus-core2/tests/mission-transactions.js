/*\
title: $:/plugins/clerus/core/tests/mission-transactions.js
type: application/javascript
module-type: library
\*/

"use strict";

var scopes = require("$:/plugins/clerus/core/scope.js");
var perspectives = require(
	"$:/plugins/clerus/core/project-perspective.js"
);
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

function fixture(tw, settings) {
	settings = settings || {};

	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title =
		"$:/temp/clerus/jobs/" + platform + "/mission-transactions";
	var project = "Core2 Mission Transactions Project";

	var root = {
		form: "mission",
		project: project,
		role: [],
		link: "10",
		issued: "0",
		children: {}
	};

	var operational = {
		charter: {
			form: "charter",
			status: {}
		}
	};

	if (settings.operationalAlias) {
		operational.root = clone(root);
	}

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "mission-transactions",
		text: JSON.stringify(operational)
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": platform,
		text: JSON.stringify({
			task: { name: "root" },
			parts: {
				item: {
					task: { name: "item" },
					parts: {
						leaf: {
							task: { name: "leaf" },
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

	var service = perspectives.create({
		title: title,
		platform: platform,
		store: store,

		readJobs: function () {
			var current = wiki.getTiddler(title);

			return [{
				title: title,
				custody: current.fields["clerus-custody"],
				registry: JSON.parse(current.fields.text)
			}];
		}
	});

	var incoming = {
		root: clone(root)
	};

	if (settings.conflictingAlias) {
		incoming.alias = clone(root);
		incoming.alias.issued = "1";
	}

	var writes = 0;

	var scope = scopes.open({
		operational: operational,
		incoming: incoming,
		readTiddler: store.read.bind(store),
		readMission: service.readMission,
		authorizeMission: service.authorizeMutation,

		/*
		The stored job retains valid platform custody, so project
		authority exists. This separate gate denies operational
		writes and tests cumulative effect authorization.
		*/
		canWriteOperational: function () {
			return false;
		},

		commitOperational: function () {
			writes++;
			throw new Error("Writer must not be reached");
		}
	});

	return {
		wiki: wiki,
		title: title,
		scope: scope,

		writes: function () {
			return writes;
		},

		storedRegistryText: function () {
			return wiki.getTiddler(title).fields.text;
		}
	};
}

function testIncomingParentCreatesOutgoingChild(tw) {
	var f = fixture(tw);
	var scope = f.scope;
	var before = f.storedRegistryText();

	try {
		var parent = scope.incoming.get("root");
		var outgoing = scope.incoming.outgoing();

		assert(parent.inspect().active);

		var child = parent.createMission(
			"item",
			outgoing,
			"child"
		);

		assert(child === outgoing.get("child"));
		assert(child.inspect().active);
		assert(child.task().name === "item");

		var snapshot = scope.snapshot();

		assert(snapshot.incoming.root.issued === "1");
		assert(
			snapshot.incoming.root.children.item === "10/1"
		);
		assert(snapshot.outgoing[0].child.link === "10/1");

		assert(
			Object.keys(snapshot.operational).join(",") === "charter"
		);

		assert(f.writes() === 0);
		assert(f.storedRegistryText() === before);

		// Explicitly consume the remaining incoming parent.
		scope.incoming.destroy("root");
		scope.assertResolved();

		// Destroying its authority deactivates, but does not erase, the child.
		assert(!child.inspect().active);
		assert(outgoing.keys().join(",") === "child");
	} finally {
		scope.close();
	}
}

function testNestedOutgoingIssuance(tw) {
	var f = fixture(tw);
	var scope = f.scope;

	try {
		var outgoing = scope.incoming.outgoing();

		var child = scope.incoming.get("root").createMission(
			"item",
			outgoing,
			"child"
		);

		var leaf = child.createMission(
			"leaf",
			outgoing,
			"leaf"
		);

		assert(leaf.inspect().active);
		assert(leaf.task().name === "leaf");

		var snapshot = scope.snapshot();

		assert(snapshot.outgoing[0].child.issued === "1");
		assert(
			snapshot.outgoing[0].child.children.leaf === "10/1/1"
		);
		assert(snapshot.outgoing[0].leaf.link === "10/1/1");
		assert(f.writes() === 0);
	} finally {
		scope.close();
	}
}

function testTransactionalRevocation(tw) {
	var f = fixture(tw);
	var scope = f.scope;

	try {
		var parent = scope.incoming.get("root");
		var outgoing = scope.incoming.outgoing();

		var old = parent.createMission(
			"item",
			outgoing,
			"old"
		);

		parent.revokePart("item");

		assert(!old.inspect().active);

		var replacement = parent.createMission(
			"item",
			outgoing,
			"replacement"
		);

		assert(replacement.inspect().active);
		assert(!old.inspect().active);

		var snapshot = scope.snapshot();

		assert(snapshot.incoming.root.issued === "2");
		assert(snapshot.outgoing[0].old.link === "10/1");
		assert(snapshot.outgoing[0].replacement.link === "10/2");
		assert(f.writes() === 0);
	} finally {
		scope.close();
	}
}

function testOperationalAliasPreventsBypass(tw) {
	var f = fixture(tw, {
		operationalAlias: true
	});

	var scope = f.scope;

	try {
		var parent = scope.incoming.get("root");
		var outgoing = scope.incoming.outgoing();

		assert(parent === scope.operational.get("root"));
		assert(parent.inspect().active);

		var before = JSON.stringify(scope.snapshot());
		var storedBefore = f.storedRegistryText();

		throws(function () {
			parent.createMission("item", outgoing, "child");
		}, "not writable");

		assert(JSON.stringify(scope.snapshot()) === before);
		assert(f.storedRegistryText() === storedBefore);
		assert(outgoing.keys().length === 0);
		assert(f.writes() === 0);

		// The rejected operation did not consume a generation.
		assert(scope.snapshot().incoming.root.issued === "0");
		assert(
			scope.snapshot().operational.root.issued === "0"
		);
	} finally {
		scope.close();
	}
}

function testConflictingAliasesRejectIssuance(tw) {
	var f = fixture(tw, {
		conflictingAlias: true
	});

	var scope = f.scope;

	try {
		var parent = scope.incoming.get("root");
		var outgoing = scope.incoming.outgoing();

		assert(
			parent !== scope.incoming.get("alias")
		);

		assert(!parent.inspect().active);

		var before = JSON.stringify(scope.snapshot());

		throws(function () {
			parent.createMission("item", outgoing, "child");
		}, "conflicting-copies");

		assert(JSON.stringify(scope.snapshot()) === before);
		assert(f.writes() === 0);
	} finally {
		scope.close();
	}
}

function testIncomingDestinationIsRejected(tw) {
	var f = fixture(tw);
	var scope = f.scope;

	try {
		var before = JSON.stringify(scope.snapshot());

		throws(function () {
			scope.incoming.get("root").createMission(
				"item",
				scope.incoming,
				"child"
			);
		}, "Cannot insert documents into incoming registry");

		assert(JSON.stringify(scope.snapshot()) === before);
	} finally {
		scope.close();
	}
}

exports.run = function (tw) {
	var cases = [
		["mission transactions: incoming parent issues outgoing child", testIncomingParentCreatesOutgoingChild],
		["mission transactions: nested issuance uses current scope", testNestedOutgoingIssuance],
		["mission transactions: revocation preserves stale documents", testTransactionalRevocation],
		["mission transactions: operational alias prevents write bypass", testOperationalAliasPreventsBypass],
		["mission transactions: conflicting aliases reject issuance", testConflictingAliasesRejectIssuance],
		["mission transactions: incoming registry cannot receive insertion", testIncomingDestinationIsRejected]
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