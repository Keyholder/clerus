/*\
title: $:/plugins/clerus/tests/core/flow-materialization.js
type: application/javascript
module-type: library
\*/

"use strict";

var flows = require("$:/plugins/clerus/core/flow-obligations.js");
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

function fixture(tw, messageOnly) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var owner = "$:/clerus/jobs/flow-root";
	var recipient = "$:/clerus/jobs/flow-recipient";

	wiki.addTiddler(new tw.Tiddler({
		title: owner,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "flow-root",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "initial" }
			},
			recipient: recipient
		})
	}));

	var store = new stores.Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var before = store.read(owner).fields;
	var after = Object.assign({}, before);

	var registry = JSON.parse(before.text);
	registry.charter.status.phase = "completed";
	after.text = JSON.stringify(registry);

	var proposal = {
		version: 1,
		owner: {
			title: owner,
			executor: "flow-root",
			state: before
		},
		plan: {
			version: 1,
			effects: messageOnly
				? []
				: [stores.transition(owner, before, after)],
			messages: [{
				version: 1,
				kind: "official-message",
				id: "flow-root-message-0001",
				platform: platform,
				type: "order",
				source: {
					title: owner,
					executor: "flow-root"
				},
				recipient: {
					title: recipient,
					executor: "flow-recipient"
				},
				registry: {
					note: { form: "memo", data: 42 }
				}
			}]
		}
	};

	var service = flows.create({
		store: store,
		platform: platform,
		newId: function () {
			return "flow-root-identity-0001";
		}
	});

	return {
		wiki: wiki,
		store: store,
		owner: owner,
		platform: platform,
		proposal: proposal,
		service: service,

		restore: function (title) {
			wiki.addTiddler(new tw.Tiddler(
				wiki.getTiddler(title),
				{ "clerus-custody": platform }
			));
		}
	};
}

function testRootBecomesPendingMessages(tw) {
	var f = fixture(tw);
	var title = f.service.register(f.proposal);

	assert(f.service.pending(title).length === 0);

	var messages = f.service.resume(title);
	var record = f.service.read(title).record;

	assert(messages.length === 1);
	assert(record.active === null);
	assert(record.pending.length === 1);
	assert(Object.keys(record.seen).length === 1);

	var repeated = f.service.resume(title);

	assert(repeated.length === 1);
	assert(f.service.read(title).record.pending.length === 1);
}

function testInterruptedRootRecovers(tw) {
	var f = fixture(tw);
	var title = f.service.register(f.proposal);
	var originalApply = f.store.apply;
	var injected = false;

	f.store.apply = function (effect) {
		var result = originalApply.call(this, effect);

		if (effect.title === f.owner && !injected) {
			injected = true;
			throw new Error("Interrupted root materialization");
		}

		return result;
	};

	try {
		throws(function () {
			f.service.resume(title);
		}, "Interrupted root materialization");
	} finally {
		f.store.apply = originalApply;
	}

	var paused = JSON.parse(
		f.wiki.getTiddler(title).fields.text
	);

	assert(paused.active !== null);
	assert(paused.pending.length === 0);

	f.restore(title);

	var messages = f.service.resume(title);

	assert(messages.length === 1);
	assert(f.service.read(title).record.active === null);
	assert(f.service.pending(title).length === 1);
}

function testMessageOnlyRoot(tw) {
	var f = fixture(tw, true);
	var before = f.wiki.getTiddler(f.owner).fields.text;

	var title = f.service.register(f.proposal);
	var messages = f.service.resume(title);

	assert(messages.length === 1);
	assert(f.wiki.getTiddler(f.owner).fields.text === before);
	assert(f.service.read(title).record.active === null);
}

exports.run = function (tw) {
	var cases = [
		["flow materialization: root becomes pending messages", testRootBecomesPendingMessages],
		["flow materialization: interrupted root resumes without duplication", testInterruptedRootRecovers],
		["flow materialization: message-only root needs no synthetic write", testMessageOnlyRoot]
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