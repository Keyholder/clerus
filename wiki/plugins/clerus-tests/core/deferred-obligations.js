/*\
title: $:/plugins/clerus/core/tests/deferred-obligations.js
type: application/javascript
module-type: library
\*/

"use strict";

var flows = require("$:/plugins/clerus/core/flow-obligations.js");
var deferred = require(
	"$:/plugins/clerus/core/deferred-obligations.js"
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

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/deferred-obligation-owner";

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "owner",
		text: JSON.stringify({
			charter: { form: "charter", status: {} }
		})
	}));

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var effect = {
		version: 1,
		kind: "deferred-event",
		id: "deferred-obligation-event-0001",
		platform: platform,
		recipient: { title: owner, executor: "owner" }
	};

	var manager = flows.create({
		store: store,
		platform: platform,
		newId: function () {
			return "deferred-parent-flow-identity";
		}
	});

	var parent = manager.register({
		version: 1,
		owner: {
			title: owner,
			executor: "owner",
			state: store.read(owner).fields
		},
		plan: {
			version: 1,
			effects: [],
			messages: [],
			deferred: [effect]
		}
	});

	var child =
		"$:/clerus/wal/" + platform +
		"/deferred-" + effect.id;

	return {
		wiki: wiki,
		store: store,
		platform: platform,
		effect: effect,
		manager: manager,
		parent: parent,
		child: child,

		deferred: deferred.create({
			store: store,
			platform: platform
		})
	};
}

function testParentCanFinishBeforeTick(tw) {
	var f = fixture(tw);

	assert(!f.wiki.getTiddler(f.child));

	assert(f.manager.resume(f.parent).length === 0);

	assert(!f.wiki.getTiddler(f.parent));
	assert(f.wiki.getTiddler(f.child));
	assert(f.deferred.read(f.child).effect.id === f.effect.id);
}

function testInterruptedRegistrationDoesNotDuplicate(tw) {
	var f = fixture(tw);
	var originalApply = f.store.apply;
	var injected = false;

	f.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.child && !injected) {
			injected = true;
			throw new Error("Interrupted after deferred registration");
		}

		return result;
	};

	try {
		throws(function () {
			f.manager.resume(f.parent);
		}, "Interrupted after deferred registration");
	} finally {
		f.store.apply = originalApply;
	}

	assert(f.wiki.getTiddler(f.child));
	assert(f.wiki.getTiddler(f.parent));

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.parent),
		{ "clerus-custody": f.platform }
	));

	assert(f.manager.resume(f.parent).length === 0);
	assert(!f.wiki.getTiddler(f.parent));

	var children = [];

	f.wiki.each(function (tiddler, title) {
		if (tiddler.fields["clerus-wal-kind"] === "deferred") {
			children.push(title);
		}
	});

	assert(children.length === 1);
	assert(children[0] === f.child);
}

function testPausedChildIsNotReclaimed(tw) {
	var f = fixture(tw);

	f.deferred.record(f.effect);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.child),
		{ "clerus-custody": "user" }
	));

	assert(f.manager.resume(f.parent).length === 0);

	assert(!f.wiki.getTiddler(f.parent));
	assert(
		f.wiki.getTiddler(f.child)
			.fields["clerus-custody"] === "user"
	);
}

exports.run = function (tw) {
	var cases = [
		["deferred obligations: parent completes before activation", testParentCanFinishBeforeTick],
		["deferred obligations: interrupted registration is deduplicated", testInterruptedRegistrationDoesNotDuplicate],
		["deferred obligations: paused child is not reclaimed", testPausedChildIsNotReclaimed]
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