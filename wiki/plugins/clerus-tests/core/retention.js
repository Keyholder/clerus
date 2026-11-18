/*\
title: $:/plugins/clerus/tests/core/retention.js
type: application/javascript
module-type: library
\*/

"use strict";

var retention = require("$:/plugins/clerus/core/retention.js");
var events = require("$:/plugins/clerus/core/event-schema.js");

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

function continuation() {
	return {
		version: 2,
		kind: "continuation",
		platform: "browser",
		retainUntil: 0,
		work: null,
		events: {},
		evidence: {
			identities: {},
			receipts: {}
		},
		diagnostics: []
	};
}

function addEvent(record, id, event, mode) {
	record.events[id] = {
		mode: mode,
		event: event
	};

	record.evidence.identities[id] = events.fingerprint(event);
}

function testPendingNotHistoryRetains() {
	var body = continuation();
	var id = "retention-message-identity";

	var event = {
		kind: "delivery",
		type: "order",
		recipient: {
			title: title("target"),
			executor: "target"
		},
		registry: {}
	};

	addEvent(body, id, event, "ready");

	var jobs = [job("source"), job("target")];

	var active = evaluate(jobs, [
		wal("pending", "continuation", body)
	]);

	assert(active.complete);
	assert(active.retained.length === 1);
	assert(active.retained[0].title === title("target"));
	assert(active.candidates.includes(title("source")));

	delete body.events[id];

	/*
	The fingerprint and a diagnostic snapshot are history,
	not another location of the delivered documents.
	*/
	body.diagnostics.push({
		phase: "historical",
		snapshot: event
	});

	var historical = evaluate(jobs, [
		wal("historical", "continuation", body)
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

	var body = continuation();

	body.work = {
		version: 2,
		id: "retention-future-reference-work-0001",
		checks: [],
		transitions: [{
			version: 1,
			title: owner.title,
			before: before,
			after: after
		}],
		blocks: [],
		emits: []
	};

	var report = evaluate([owner, job("target")], [
		wal("accepted", "continuation", body)
	]);

	assert(report.complete);
	assert(report.retained.length === 2);
	assert(report.candidates.length === 0);
}

function testPausedActivationRetains() {
	var body = continuation();
	var id = "retention-activation-identity";

	addEvent(body, id, {
		kind: "activation",
		recipient: {
			title: title("target"),
			executor: "target"
		}
	}, "paused");

	var report = evaluate([job("target")], [
		wal("paused-activation", "continuation", body)
	]);

	assert(report.complete);
	assert(report.retained.length === 1);
	assert(report.retained[0].title === title("target"));
	assert(report.retained[0].reasons.some(function (reason) {
		return reason.kind === "waiting-event" &&
			reason.event === id;
	}));
	assert(report.candidates.length === 0);
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
		[
			"retention: paused activation retains its recipient",
			testPausedActivationRetains
		],
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