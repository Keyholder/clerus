/*\
title: $:/plugins/clerus/tests/core/persistent-suspension.js
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

function fixture(tw, handler, foreignCustody) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = "$:/clerus/jobs/suspension-owner";
	var sequence = 0;

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": foreignCustody
			? (platform === "browser" ? "node" : "browser")
			: platform,
		"clerus-executor": "suspension-owner",
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: { phase: "working" }
			},
			mission: {
				form: "mission",
				project: "Core2 Suspension Project",
				role: [],
				link: "10",
				issued: "0",
				children: {}
			}
		})
	}));

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "suspension-test-" +
				String(sequence).padStart(10, "0");
		},

		resolveExecutor: function (name) {
			return name === "suspension-owner"
				? handler
				: undefined;
		}
	});

	return {
		wiki: wiki,
		title: title,
		runtime: runtime
	};
}

function testSuspensionPreservesDocuments(tw) {
	var notifications = 0;
	var f;

	f = fixture(tw, function (event, operational) {
		if (event.type === "suspended") {
			notifications++;

			assert(operational.get("mission").inspect().active);

			throws(function () {
				operational.get("charter").setStatus({});
			}, "not writable");

			return;
		}

		operational.get("charter").setStatus({
			phase: "must be discarded"
		});

		throw new Error("Persistent executor failure");
	});

	var before = f.wiki.getTiddler(f.title).fields.text;

	var result = f.runtime.dispatch(
		f.title,
		{ type: "test" }
	);

	assert(result.status === "failed");
	assert(result.phase === "reaction");
	assert(result.lifecycle.suspended);
	assert(result.lifecycle.incident);
	assert(result.notification.status === "completed");
	assert(notifications === 1);

	var current = f.wiki.getTiddler(f.title);

	assert(current.fields["clerus-custody"] === "user");
	assert(current.fields["clerus-suspended"] === "yes");
	assert(current.fields.text === before);

	assert(f.runtime.inspect().missions.active.length === 1);

	var incident = f.wiki.getTiddler(
		result.lifecycle.incident
	);

	assert(incident);
	assert(incident.fields["clerus-custody"] === "user");
}

function testNotificationFailureIsNotRecursive(tw) {
	var notifications = 0;

	var f = fixture(tw, function (event) {
		if (event.type === "suspended") {
			notifications++;
			throw new Error("Restricted notification failed");
		}

		throw new Error("Initial executor failure");
	});

	var result = f.runtime.dispatch(
		f.title,
		{ type: "test" }
	);

	assert(result.lifecycle.suspended);
	assert(result.notification.status === "ignored-error");
	assert(notifications === 1);

	var incidents = [];

	f.wiki.each(function (tiddler, title) {
		if (tiddler.fields["clerus-wal-kind"] === "incident") {
			incidents.push(title);
		}
	});

	assert(incidents.length === 1);
}

function testForeignFailureDoesNotSuspend(tw) {
	var notifications = 0;

	var f = fixture(tw, function (event) {
		if (event.type === "suspended") {
			notifications++;
		}

		throw new Error("Foreign executor failure");
	}, true);

	var before = f.wiki.getTiddler(f.title).fields["clerus-custody"];

	var result = f.runtime.dispatch(
		f.title,
		{ type: "test" }
	);

	assert(result.status === "failed");
	assert(result.lifecycle);
	assert(!result.lifecycle.suspended);
	assert(result.lifecycle.reason === "not-locally-owned");
	assert(result.lifecycle.incident);
	assert(notifications === 0);

	assert(
		f.wiki.getTiddler(f.title)
			.fields["clerus-custody"] === before
	);

	assert(
		!f.wiki.getTiddler(f.title)
			.fields["clerus-suspended"]
	);
}

exports.run = function (tw) {
	var cases = [
		["persistent suspension: documents and missions remain intact", testSuspensionPreservesDocuments],
		["persistent suspension: notification failure is not recursive", testNotificationFailureIsNotRecursive],
		["persistent suspension: foreign executor is not suspended", testForeignFailureDoesNotSuspend]
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