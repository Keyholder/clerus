/*\
title: $:/plugins/clerus/core/tests/planned-sending.js
type: application/javascript
module-type: library
\*/

"use strict";

var plannedReactions = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);

var plannedScopes = require(
	"$:/plugins/clerus/core/planned-scope.js"
);

var Plan = require("$:/plugins/clerus/core/plan.js").Plan;
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

function fixture(tw, foreignCustody) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = "$:/clerus/jobs/planned-sending-source";
	var recipient = "$:/clerus/jobs/planned-sending-recipient";

	function write(title, executor, registry, custody) {
		registry.charter = {
			form: "charter",
			status: {}
		};

		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": custody,
			"clerus-executor": executor,
			text: JSON.stringify(registry)
		}));
	}

	write(source, "source", {
		recipient: recipient,
		note: {
			form: "memo",
			data: { value: 42 }
		}
	}, foreignCustody ? "user" : platform);

	write(recipient, "recipient", {}, platform);

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var sequence = 0;

	function newId() {
		sequence++;

		return "planned-send-identity-" +
			String(sequence).padStart(8, "0");
	}

	return {
		wiki: wiki,
		store: store,
		source: source,
		recipient: recipient,
		platform: platform,
		newId: newId,

		execute: function (handler) {
			return plannedReactions.execute({
				store: store,
				title: source,
				platform: platform,
				event: { type: "test" },
				newId: newId,
				handler: handler
			});
		}
	};
}

function prepareOrder(operational) {
	var outgoing = operational.outgoing();

	operational.copy("note", outgoing, "instruction");
	operational.get("recipient").order(outgoing);

	return outgoing;
}

function testSendingRemainsInsideProposal(tw) {
	var f = fixture(tw);
	var sourceBefore = f.wiki.getTiddler(f.source).fields.text;
	var recipientBefore = f.wiki.getTiddler(f.recipient).fields.text;

	var proposal = f.execute(function (event, operational) {
		var outgoing = prepareOrder(operational);

		throws(function () {
			outgoing.keys();
		}, "no longer available");

		operational.get("charter").setStatus({
			phase: "proposed"
		});
	});

	assert(proposal.plan.messages.length === 1);
	assert(proposal.plan.effects.length === 1);

	var message = proposal.plan.messages[0];

	assert(message.source.executor === "source");
	assert(message.recipient.executor === "recipient");
	assert(message.registry.instruction.data.value === 42);
	assert(message.id.length >= 16);

	assert(f.wiki.getTiddler(f.source).fields.text === sourceBefore);
	assert(f.wiki.getTiddler(f.recipient).fields.text === recipientBefore);
}

function testFailureDiscardsSending(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.source).fields.text;

	throws(function () {
		f.execute(function (event, operational) {
			prepareOrder(operational);
			throw new Error("Rejected after proposed sending");
		});
	}, "Rejected after proposed sending");

	assert(f.wiki.getTiddler(f.source).fields.text === before);

	var journals = [];

	f.wiki.each(function (tiddler, title) {
		if (title.indexOf("$:/clerus/wal/") === 0) {
			journals.push(title);
		}
	});

	assert(journals.length === 0);
}

function testSendingWithoutOperationalWrite(tw) {
	var f = fixture(tw, true);

	var proposal = f.execute(function (event, operational) {
		prepareOrder(operational);
	});

	assert(proposal.plan.effects.length === 0);
	assert(proposal.plan.messages.length === 1);
	assert(proposal.owner.state["clerus-custody"] === "user");
}

function testFailedMessageInsertionIsAtomic(tw) {
	var f = fixture(tw);
	var plan = new Plan(f.store.snapshot());

	var scope = plannedScopes.open({
		plan: plan,
		title: f.source,
		platform: f.platform,
		eventType: "test",
		newId: f.newId
	});

	var originalFork = plan.fork;

	try {
		var outgoing = scope.operational.outgoing();

		scope.operational.copy("note", outgoing, "instruction");

		var before = JSON.stringify(scope.snapshot());

		plan.fork = function () {
			var branch = originalFork.call(this);
			var originalSend = branch.send;

			branch.send = function (message) {
				originalSend.call(this, message);
				throw new Error("Injected planned send failure");
			};

			return branch;
		};

		throws(function () {
			scope.operational.get("recipient").order(outgoing);
		}, "Injected planned send failure");

		assert(JSON.stringify(scope.snapshot()) === before);
		assert(plan.export().messages.length === 0);
		assert(outgoing.keys().join(",") === "instruction");

		plan.fork = originalFork;

		scope.operational.get("recipient").order(outgoing);

		assert(plan.export().messages.length === 1);
		scope.assertOutgoingResolved();
	} finally {
		plan.fork = originalFork;
		scope.close();
		plan.abort();
	}
}

exports.run = function (tw) {
	var cases = [
		["planned sending: message stays inside the proposal", testSendingRemainsInsideProposal],
		["planned sending: reaction failure discards sending", testFailureDiscardsSending],
		["planned sending: sending does not require operational writing", testSendingWithoutOperationalWrite],
		["planned sending: failed insertion preserves plan and scope", testFailedMessageInsertionIsAtomic]
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