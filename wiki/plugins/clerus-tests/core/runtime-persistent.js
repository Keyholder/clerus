/*\
title: $:/plugins/clerus/tests/core/runtime-persistent.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;

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

function fixture(tw, handler) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/runtime-persistent-owner";
	var sequence = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "runtime-persistent",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			}
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "runtime-persistent-" +
				String(sequence).padStart(8, "0");
		},

		resolveExecutor: function (name) {
			return name === "runtime-persistent"
				? handler
				: undefined;
		}
	});

	return {
		wiki: wiki,
		title: title,
		platform: platform,
		runtime: runtime,

		phase: function () {
			return JSON.parse(
				wiki.getTiddler(title).fields.text
			).charter.status.phase;
		}
	};
}

function complete(event, operational) {
	operational.get("charter").setStatus({
		phase: "completed"
	});
}

function testCompletePass(tw) {
	var calls = 0;
	var f;

	f = fixture(tw, function (event, operational) {
		calls++;

		complete(event, operational);

		assert(f.phase() === "initial");
	});

	var result = f.runtime.dispatch(
		f.title,
		{ type: "test" }
	);

	assert(result.status === "completed");
	assert(calls === 1);
	assert(f.phase() === "completed");
	assert(!f.wiki.getTiddler(result.obligation));
	assert(!f.runtime.executing);
}

function testRecoveryDoesNotActivate(tw) {
	var calls = 0;

	var f = fixture(tw, function (event, operational) {
		calls++;
		complete(event, operational);
	});

	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.title && !injected) {
			injected = true;
			throw new Error("Interrupted after owner write");
		}

		return result;
	};

	var failed;

	try {
		failed = f.runtime.dispatch(
			f.title,
			{ type: "test" }
		);
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(failed.status === "failed");
	assert(failed.phase === "materialization");
	assert(calls === 1);

	var blocked = f.runtime.dispatch(
		f.title,
		{ type: "test" }
	);

	assert(blocked.status === "blocked");
	assert(calls === 1);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(failed.obligation),
		{ "clerus-custody": f.platform }
	));

	var recovery = f.runtime.recover();

	assert(recovery.entries.some(function (entry) {
		return entry.title === failed.obligation &&
			entry.status === "completed";
	}));

	assert(calls === 1);
	assert(f.phase() === "completed");
	assert(!f.wiki.getTiddler(failed.obligation));
}

function testNestedEntryIsRejected(tw) {
	var f;

	f = fixture(tw, function () {
		throws(function () {
			f.runtime.dispatch(f.title, { type: "nested" });
		}, "nested runtime dispatch");

		throws(function () {
			f.runtime.recover();
		}, "during a reaction");

		throws(function () {
			f.runtime.observe();
		}, "Cannot collect observations during execution");
	});

	var result = f.runtime.dispatch(
		f.title,
		{ type: "test" }
	);

	assert(result.status === "completed");
	assert(result.obligation === null);
	assert(!f.runtime.executing);
}

function testReactionFailureDoesNotHideTransition(tw) {
	var f = fixture(tw, function (event, operational) {
		complete(event, operational);
		throw new Error("Executor rejected its proposal");
	});

	var result = f.runtime.dispatch(
		f.title,
		{ type: "test" }
	);

	assert(result.status === "failed");
	assert(result.phase === "reaction");
	assert(f.phase() === "initial");
    assert(result.lifecycle.suspended);

    assert(
        f.wiki.getTiddler(f.title)
            .fields["clerus-custody"] === "user"
    );

    assert(
        f.wiki.getTiddler(f.title)
            .fields["clerus-suspended"] === "yes"
    );
}

function testMalformedRegistryIsPreparationFailure(tw) {
	var invoked = false;

	var f = fixture(tw, function () {
		invoked = true;
	});

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.title),
		{ text: "null" }
	));

	var result = f.runtime.dispatch(
		f.title,
		{ type: "test" }
	);

	assert(result.status === "failed");
	assert(result.phase === "preparation");
	assert(!invoked);
	assert(!f.runtime.executing);
}

exports.run = function (tw) {
	var cases = [
		["runtime persistent: complete pass is integrated", testCompletePass],
		["runtime persistent: recovery does not activate executor", testRecoveryDoesNotActivate],
		["runtime persistent: nested entry is rejected", testNestedEntryIsRejected],
		["runtime persistent: reaction failure remains distinct", testReactionFailureDoesNotHideTransition],
		["runtime persistent: malformed registry is not an executor failure", testMalformedRegistryIsPreparationFailure]
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