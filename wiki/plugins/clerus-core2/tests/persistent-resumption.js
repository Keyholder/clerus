/*\
title: $:/plugins/clerus/core2/tests/persistent-resumption.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core2/runtime.js").Runtime;

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw, handler) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/resumption-owner";
	var sequence = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": "user",
		"clerus-suspended": "yes",
		"clerus-executor": "resumption-owner",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "before-repair" }
			}
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "resumption-test-" +
				String(sequence).padStart(10, "0");
		},

		resolveExecutor: function (name) {
			return name === "resumption-owner"
				? handler
				: undefined;
		}
	});

	return {
		wiki: wiki,
		title: title,
		platform: platform,
		runtime: runtime,

		authorize: function () {
			wiki.addTiddler(new tw.Tiddler(
				wiki.getTiddler(title),
				{ "clerus-custody": platform }
			));
		},

		phase: function () {
			return JSON.parse(
				wiki.getTiddler(title).fields.text
			).charter.status.phase;
		}
	};
}

function testExplicitResumption(tw) {
	var calls = 0;

	var f = fixture(tw, function (event, operational) {
		assert(event.type === "resumed");
		calls++;

		operational.get("charter").setStatus({
			phase: "running"
		});
	});

	f.authorize();

	var blocked = f.runtime.dispatch(
		f.title,
		{ type: "ordinary-event" }
	);

	assert(blocked.status === "blocked");
	assert(blocked.reason === "resumption-required");
	assert(calls === 0);

	var result = f.runtime.resume(f.title);

	assert(result.status === "completed");
	assert(calls === 1);
	assert(f.phase() === "running");

	assert(
		!f.wiki.getTiddler(f.title)
			.fields["clerus-suspended"]
	);

	var repeated = f.runtime.resume(f.title);

	assert(repeated.status === "unavailable");
	assert(repeated.reason === "resumption-not-pending");
	assert(calls === 1);
}

function testNoopResumptionStillConfirms(tw) {
	var f = fixture(tw, function (event) {
		assert(event.type === "resumed");
	});

	f.authorize();

	var result = f.runtime.resume(f.title);

	assert(result.status === "completed");
	assert(result.obligation);
	assert(!f.wiki.getTiddler(result.obligation));

	assert(
		!f.wiki.getTiddler(f.title)
			.fields["clerus-suspended"]
	);

	assert(f.phase() === "before-repair");
}

function testInterruptedConfirmationDoesNotRepeatHandler(tw) {
	var calls = 0;

	var f = fixture(tw, function (event, operational) {
		assert(event.type === "resumed");
		calls++;

		operational.get("charter").setStatus({
			phase: "running"
		});
	});

	f.authorize();

	var originalApply = f.runtime.store.apply;
	var injected = false;

	f.runtime.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (
			effect.title === f.title &&
			effect.after &&
			!effect.after["clerus-suspended"] &&
			!injected
		) {
			injected = true;
			throw new Error("Interrupted after resumption write");
		}

		return result;
	};

	var failed;

	try {
		failed = f.runtime.resume(f.title);
	} finally {
		f.runtime.store.apply = originalApply;
	}

	assert(injected);
	assert(failed.status === "failed");
	assert(failed.phase === "materialization");
	assert(calls === 1);
	assert(f.phase() === "running");

	assert(
		!f.wiki.getTiddler(f.title)
			.fields["clerus-suspended"]
	);

	// The remaining obligation, not the marker, now blocks new work.
	var blocked = f.runtime.dispatch(
		f.title,
		{ type: "ordinary-event" }
	);

	assert(blocked.status === "blocked");
	assert(blocked.obligations.includes(failed.obligation));
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
	assert(!f.wiki.getTiddler(failed.obligation));

	var repeated = f.runtime.resume(f.title);

	assert(repeated.reason === "resumption-not-pending");
	assert(calls === 1);
}

function testUserCustodyCannotResume(tw) {
	var called = false;

	var f = fixture(tw, function () {
		called = true;
	});

	var result = f.runtime.resume(f.title);

	assert(result.status === "unavailable");
	assert(result.reason === "resumption-not-pending");
	assert(!called);

	assert(
		f.wiki.getTiddler(f.title)
			.fields["clerus-suspended"] === "yes"
	);
}

exports.run = function (tw) {
	var cases = [
		["persistent resumption: explicit resumption precedes ordinary work", testExplicitResumption],
		["persistent resumption: noop handler still confirms lifecycle", testNoopResumptionStillConfirms],
		["persistent resumption: interrupted confirmation does not repeat handler", testInterruptedConfirmationDoesNotRepeatHandler],
		["persistent resumption: user custody does not authorize resumption", testUserCustodyCannotResume]
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