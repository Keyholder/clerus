/*\
title: $:/plugins/clerus/core2/tests/establishment-effects.js
type: application/javascript
module-type: library
\*/

"use strict";

var messages = require(
	"$:/plugins/clerus/core2/message-effect.js"
);
var flows = require(
	"$:/plugins/clerus/core2/flow-obligations.js"
);
var Store = require("$:/plugins/clerus/core2/store.js").Store;

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

function message(platform) {
	return {
		version: 1,
		kind: "official-message",
		id: "establishment-message-0001",
		platform: platform,
		type: "order",
		establishing: true,

		source: {
			title: "$:/clerus/jobs/establishment-effect-source",
			executor: "source"
		},

		recipient: {
			title: "$:/clerus/jobs/establishment-effect-target",
			executor: "worker"
		},

		registry: {
			contract: {
				form: "contract",
				executor: "worker",
				temp: false,
				book: { instruction: "start" }
			},

			note: {
				form: "memo",
				data: 42
			}
		}
	};
}

function testContractRemainsUntransformed() {
	var source = message("browser");
	var effect = messages.validate(source);

	assert(effect.establishing === true);
	assert(effect.registry.contract.form === "contract");
	assert(effect.registry.note.data === 42);

	effect.registry.contract.book.instruction = "local";

	assert(
		source.registry.contract.book.instruction === "start"
	);
}

function testExecutorMustMatch() {
	var source = message("browser");
	source.recipient.executor = "replacement";

	throws(function () {
		messages.validate(source);
	}, "does not match");
}

function testExactlyOneContract() {
	var missing = message("browser");
	delete missing.registry.contract;

	throws(function () {
		messages.validate(missing);
	}, "exactly one contract");

	var duplicate = message("browser");

	duplicate.registry.second = {
		form: "contract",
		executor: "worker"
	};

	throws(function () {
		messages.validate(duplicate);
	}, "exactly one contract");
}

function testDurabilityConstraint() {
	var source = message("browser");
	source.registry.contract.temp = true;

	throws(function () {
		messages.validate(source);
	}, "recipient durability");
}

function testReportCannotEstablish() {
	var source = message("browser");
	source.type = "report";
	source.project = "Establishment Project";
	source.role = ["item"];

	throws(function () {
		messages.validate(source);
	}, "requires an order");
}

function testSendingDoesNotCreateRecipient(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var outgoing = message(platform);

	wiki.addTiddler(new tw.Tiddler({
		title: outgoing.source.title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "source",

		text: JSON.stringify({
			charter: {
				form: "charter",
				status: {}
			},
			futureSubordinate: outgoing.recipient.title
		})
	}));

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var manager = flows.create({
		store: store,
		platform: platform,
		newId: function () {
			return "establishment-effect-flow-0001";
		}
	});

	var journal = manager.register({
		version: 1,

		owner: {
			title: outgoing.source.title,
			executor: outgoing.source.executor,
			state: store.read(outgoing.source.title).fields
		},

		plan: {
			version: 1,
			effects: [],
			messages: [outgoing]
		}
	});

	assert(store.read(outgoing.recipient.title).kind === "absent");

	var pending = manager.resume(journal);

	assert(pending.length === 1);
	assert(pending[0].establishing);
	assert(pending[0].registry.contract.form === "contract");
	assert(store.read(outgoing.recipient.title).kind === "absent");

	var repeated = manager.resume(journal);

	assert(repeated.length === 1);
	assert(repeated[0].id === outgoing.id);
	assert(store.read(outgoing.recipient.title).kind === "absent");
}

exports.run = function (tw) {
	var cases = [
		["establishment effects: contract remains untransformed", testContractRemainsUntransformed],
		["establishment effects: executor is bound to contract", testExecutorMustMatch],
		["establishment effects: exactly one contract is required", testExactlyOneContract],
		["establishment effects: durability constraint is enforced", testDurabilityConstraint],
		["establishment effects: report cannot establish a job", testReportCannotEstablish],
		["establishment effects: sending preserves an absent recipient", function () {
			testSendingDoesNotCreateRecipient(tw);
		}]
	];

	var results = cases.map(function (item) {
		try {
			item[1]();

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