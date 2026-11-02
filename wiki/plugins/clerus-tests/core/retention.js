/*\
title: $:/plugins/clerus/tests/core/retention.js
type: application/javascript
module-type: library
\*/

"use strict";

var retention = require("$:/plugins/clerus/core/retention.js");
var messages = require("$:/plugins/clerus/core/message-effect.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function title(name) {
	return "$:/clerus/jobs/retention-" + name;
}

function registry(extra) {
	return Object.assign({
		charter: { form: "charter", status: {} }
	}, extra || {});
}

function job(name, extra) {
	return {
		title: title(name),
		custody: "browser",
		registry: registry(extra)
	};
}

function wal(name, kind, body, extra) {
	return Object.assign({
		title: "$:/clerus/wal/browser/" + name,
		type: "application/json",
		"clerus-custody": "user",
		"clerus-wal-kind": kind,
		text: JSON.stringify(body)
	}, extra || {});
}

function evaluate(jobs, tiddlers) {
	return retention.evaluate({
		jobs: jobs,
		tiddlers: tiddlers || []
	});
}

function testOperationalReferencesAreImmediateGrounds() {
	var source = job("source", {
		target: title("target"),
		memo: {
			form: "memo",
			data: title("unreferenced")
		}
	});

	var report = evaluate([
		source,
		job("target"),
		job("unreferenced")
	]);

	assert(report.complete);
	assert(report.retained.length === 1);
	assert(report.retained[0].title === title("target"));
	assert(report.candidates.includes(title("source")));
	assert(report.candidates.includes(title("unreferenced")));
}

function message() {
	return {
		version: 1,
		kind: "official-message",
		id: "retention-message-identity",
		platform: "browser",
		type: "order",
		source: {
			title: title("source"),
			executor: "source"
		},
		recipient: {
			title: title("target"),
			executor: "target"
		},
		registry: {}
	};
}

function testPendingNotHistoryRetains() {
	var pending = message();
	var body = {
		version: 1,
		kind: "flow",
		platform: "browser",
		active: null,
		pending: [pending],
		seen: {},
		errors: []
	};

	body.seen[pending.id] = messages.fingerprint(pending);

	var jobs = [job("source"), job("target")];

	var active = evaluate(jobs, [
		wal("pending", "flow", body)
	]);

	assert(active.complete);
	assert(active.retained[0].title === title("target"));
	assert(active.candidates.includes(title("source")));

	body.pending = [];

	var historical = evaluate(jobs, [
		wal("historical", "flow", body)
	]);

	assert(historical.complete);
	assert(historical.retained.length === 0);
	assert(historical.candidates.length === 2);
}

function testAcceptedFutureReferenceRetains() {
	var owner = job("owner");
	var before = {
		title: owner.title,
		type: "application/json",
		"clerus-custody": "browser",
		"clerus-executor": "owner",
		text: JSON.stringify(owner.registry)
	};

	var after = Object.assign({}, before, {
		text: JSON.stringify(registry({
			future: title("target")
		}))
	});

	var body = {
		version: 1,
		kind: "plan",
		platform: "browser",

		proposal: {
			version: 1,
			owner: {
				title: owner.title,
				executor: "owner",
				state: before
			},
			plan: {
				version: 1,
				effects: [{
					version: 1,
					title: owner.title,
					before: before,
					after: after
				}]
			}
		}
	};

	var report = evaluate([owner, job("target")], [
		wal("accepted", "plan", body)
	]);

	assert(report.complete);
	assert(report.retained.length === 2);
	assert(report.candidates.length === 0);
}

function testPausedDeferredRetains() {
	var effect = {
		version: 1,
		kind: "deferred-event",
		id: "retention-deferred-identity",
		platform: "browser",
		recipient: {
			title: title("target"),
			executor: "target"
		}
	};

	var report = evaluate([job("target")], [
		wal(
			"deferred-" + effect.id,
			"deferred",
			{
				version: 1,
				kind: "deferred",
				platform: "browser",
				effect: effect
			},
			{
				"clerus-deferred-effect": JSON.stringify(effect)
			}
		)
	]);

	assert(report.complete);
	assert(report.retained.length === 1);
	assert(report.retained[0].reasons[0].kind === "deferred-event");
}

function testUnknownKnowledgePreventsCandidates() {
	var report = evaluate([job("unused")], [
		wal("unknown", "future", {
			version: 1,
			kind: "future",
			platform: "browser"
		})
	]);

	assert(!report.complete);
	assert(report.candidates.length === 0);
	assert(report.unretained.includes(title("unused")));

	var unsupported = evaluate([
		job("unsupported", {
			unknown: { form: "future-document" }
		})
	]);

	assert(!unsupported.complete);
	assert(unsupported.candidates.length === 0);
}

function testActiveMissionRetainsWithoutProject() {
	var report = evaluate([
		job("director", {
			mission: {
				form: "mission",
				project: "Absent Project",
				role: [],
				link: "10",
				issued: "0",
				children: {}
			}
		})
	]);

	assert(report.complete);
	assert(report.retained.length === 1);
	assert(report.retained[0].reasons[0].kind === "active-mission");
}

exports.run = function () {
	var cases = [
		["retention: immediate operational references retain independently", testOperationalReferencesAreImmediateGrounds],
		["retention: pending work retains but history does not", testPendingNotHistoryRetains],
		["retention: accepted future references retain", testAcceptedFutureReferenceRetains],
		["retention: paused deferred obligation retains", testPausedDeferredRetains],
		["retention: unknown knowledge prevents candidates", testUnknownKnowledgePreventsCandidates],
		["retention: active mission retains without its project", testActiveMissionRetainsWithoutProject]
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