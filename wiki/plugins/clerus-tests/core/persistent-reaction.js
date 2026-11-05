/*\
title: $:/plugins/clerus/tests/core/persistent-reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

var persistent = require(
	"$:/plugins/clerus/core/persistent-reaction.js"
);
var continuations = require(
	"$:/plugins/clerus/core/continuations.js"
);
var Store = require("$:/plugins/clerus/core/store.js").Store;

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/persistent-pass-owner";

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "persistent-pass",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			}
		})
	}));

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var sequence = 0;

	function newId() {
		sequence++;

		return "persistent-pass-" +
			String(sequence).padStart(10, "0");
	}

	return {
		wiki: wiki,
		store: store,
		title: title,
		platform: platform,

		execute: function (handler) {
			return persistent.execute({
				store: store,
				title: title,
				platform: platform,
				event: { type: "test" },
				handler: handler,
				newId: newId
			});
		},

		manager: function () {
			return continuations.create({
				store: store,
				platform: platform,
				newId: newId
			});
		},

		phase: function () {
			return JSON.parse(
				wiki.getTiddler(title).fields.text
			).charter.status.phase;
		}
	};
}

function proposeCompletion(event, operational) {
	operational.get("charter").setStatus({
		phase: "completed"
	});
}

function testSuccessfulPass(tw) {
	var f = fixture(tw);
	var calls = 0;

	var result = f.execute(function (event, operational) {
		calls++;

		proposeCompletion(event, operational);

		assert(f.phase() === "initial");
	});

	assert(result.status === "completed");
	assert(result.obligation);
	assert(calls === 1);
	assert(f.phase() === "completed");
	assert(!f.wiki.getTiddler(result.obligation));
}

function testReactionFailure(tw) {
	var f = fixture(tw);

	var result = f.execute(function (event, operational) {
		proposeCompletion(event, operational);
		throw new Error("Rejected proposal");
	});

	assert(result.status === "failed");
	assert(result.phase === "reaction");
	assert(result.obligation === null);
	assert(f.phase() === "initial");

	// No lifecycle transition is hidden inside the executor.
	assert(
		f.wiki.getTiddler(f.title)
			.fields["clerus-custody"] === f.platform
	);
}

function testMaterializationFailureAndRecovery(tw) {
	var f = fixture(tw);
	var originalApply = f.store.apply;
	var injected = false;
	var calls = 0;

	f.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.title && !injected) {
			injected = true;
			throw new Error("Interrupted after owner write");
		}

		return result;
	};

	var result;

	try {
		result = f.execute(function (event, operational) {
			calls++;
			proposeCompletion(event, operational);
		});
	} finally {
		f.store.apply = originalApply;
	}

	assert(injected);
	assert(result.status === "failed");
	assert(result.phase === "materialization");
	assert(result.obligation);
	assert(f.phase() === "completed");
	assert(calls === 1);

	assert(
		f.wiki.getTiddler(result.obligation)
			.fields["clerus-custody"] === "user"
	);

	var blocked = f.execute(function () {
		calls++;
	});

	assert(blocked.status === "blocked");
	assert(calls === 1);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(result.obligation),
		{ "clerus-custody": f.platform }
	));

	var recovered = f.manager().resume(result.obligation);

	assert(recovered[0] === "already-applied");
	assert(!f.wiki.getTiddler(result.obligation));
	assert(calls === 1);
}

function testRegistrationOutcomeMayBeUncertain(tw) {
	var f = fixture(tw);
	var originalApply = f.store.apply;
	var injected = false;

	f.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (
			effect.after &&
			effect.after["clerus-wal-kind"] === "continuation" &&
			!injected
		) {
			injected = true;
			throw new Error("Interrupted after WAL write");
		}

		return result;
	};

	var result;

	try {
		result = f.execute(proposeCompletion);
	} finally {
		f.store.apply = originalApply;
	}

	assert(result.status === "failed");
	assert(result.phase === "acceptance");
	assert(result.acceptanceUncertain);
	assert(result.obligation);
	assert(f.wiki.getTiddler(result.obligation));
	assert(f.phase() === "initial");

	var called = false;

	var next = f.execute(function () {
		called = true;
	});

	assert(next.status === "blocked");
	assert(!called);

	f.manager().resume(result.obligation);

	assert(f.phase() === "completed");
	assert(!f.wiki.getTiddler(result.obligation));
}

function testAcceptanceConflict(tw) {
	var f = fixture(tw);

	var result = f.execute(function (event, operational) {
		proposeCompletion(event, operational);

		f.wiki.addTiddler(new tw.Tiddler(
			f.wiki.getTiddler(f.title),
			{ caption: "intervention" }
		));
	});

	assert(result.status === "failed");
	assert(result.phase === "acceptance");
	assert(!result.acceptanceUncertain);
	assert(result.obligation === null);
	assert(f.phase() === "initial");
	assert(
		f.wiki.getTiddler(f.title).fields.caption === "intervention"
	);
}

function testEmptyPass(tw) {
	var f = fixture(tw);

	var result = f.execute(function () {});

	assert(result.status === "completed");
	assert(result.obligation === null);
	assert(result.results.length === 0);
	assert(f.phase() === "initial");
}

function testMaterialReactionUsesContinuation(tw) {
	var f = fixture(tw);
	var originalApply = f.store.apply;
	var injected = false;

	f.store.apply = function (effect) {
		if (effect.title === f.title && !injected) {
			injected = true;
			throw new Error("Stopped before materialization");
		}

		return originalApply.call(this, effect);
	};

	var result;

	try {
		result = f.execute(proposeCompletion);
	} finally {
		f.store.apply = originalApply;
	}

	assert(injected);
	assert(result.status === "failed");
	assert(result.phase === "materialization");
	assert(f.phase() === "initial");

	var journal = f.wiki.getTiddler(result.obligation);
	var record = JSON.parse(journal.fields.text);

	assert(journal.fields["clerus-wal-kind"] === "continuation");
	assert(record.version === 2);
	assert(record.kind === "continuation");
	assert(record.work);
	assert(record.work.id);
	assert(record.work.blocks.indexOf(f.title) !== -1);
	assert(record.work.transitions.length === 1);
	assert(record.work.transitions[0].title === f.title);
	assert(record.work.checks.length === 0);

	assert(
		!Object.prototype.hasOwnProperty.call(
			record.work,
			"owner"
		)
	);

	var called = false;

	var next = f.execute(function () {
		called = true;
	});

	assert(next.status === "blocked");
	assert(!called);

	f.wiki.addTiddler(new tw.Tiddler(
		journal,
		{ "clerus-custody": f.platform }
	));

	f.manager().resume(result.obligation);

	assert(f.phase() === "completed");
	assert(!f.wiki.getTiddler(result.obligation));
}

function testCompletionWriteFailureDoesNotReplayHandler(tw) {
	var f = fixture(tw);
	var originalApply = f.store.apply;
	var injected = false;
	var calls = 0;

	f.store.apply = function (effect) {
		if (
			effect.after === null &&
			effect.before &&
			effect.before["clerus-wal-kind"] === "continuation" &&
			!injected
		) {
			injected = true;
			throw new Error("Stopped before journal deletion");
		}

		return originalApply.call(this, effect);
	};

	var result;

	try {
		result = f.execute(function (event, operational) {
			calls++;
			proposeCompletion(event, operational);
		});
	} finally {
		f.store.apply = originalApply;
	}

	assert(injected);
	assert(result.status === "failed");
	assert(result.phase === "materialization");
	assert(f.phase() === "completed");
	assert(calls === 1);

	var journal = f.wiki.getTiddler(result.obligation);

	assert(journal);
	assert(journal.fields["clerus-custody"] === "user");

	f.wiki.addTiddler(new tw.Tiddler(
		journal,
		{ "clerus-custody": f.platform }
	));

	var recovered = f.manager().resume(result.obligation);

	assert(recovered[0] === "already-applied");
	assert(calls === 1);
	assert(!f.wiki.getTiddler(result.obligation));
}

exports.run = function (tw) {
	var cases = [
		["persistent reaction: complete pass calls handler once", testSuccessfulPass],
		["persistent reaction: handler failure discards proposal", testReactionFailure],
		["persistent reaction: recovery does not repeat handler", testMaterializationFailureAndRecovery],
		["persistent reaction: uncertain registration preserves possible obligation", testRegistrationOutcomeMayBeUncertain],
		["persistent reaction: acceptance conflict protects intervention", testAcceptanceConflict],
		["persistent reaction: empty result needs no obligation", testEmptyPass],
		[
			"persistent reaction: material result uses continuation v2",
			testMaterialReactionUsesContinuation
		],
		[
			"persistent reaction: completion failure does not replay handler",
			testCompletionWriteFailureDoesNotReplayHandler
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