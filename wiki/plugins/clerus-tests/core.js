/*\
title: $:/plugins/clerus/tests/core.js
type: application/javascript
module-type: library
\*/

"use strict";

var PREFIX = "$:/plugins/clerus/tests/core/";

var SUITES = Object.freeze([
	// Foundations and document capabilities
	"foundation",
	"job-titles",
	"title-issuance",
	"scope",
	"operations",
	"document-updates",
	"warrants",
	"reaction",
	"integration",

	// Organization, projects and assignments
	"hierarchy",
	"organization",
	"mission-foundation",
	"missions",
	"mission-issuance",
	"mission-scope",
	"project-perspective",
	"mission-reaction",
	"mission-mutations",
	"warrant-bindings",
	"mission-transactions",
	"task-mutations",

	// Local messaging and ephemeral execution
	"message-policy",
	"orders",
	"reports",
	"scheduler",
	"mission-delivery",
	"warrant-delegation",
	"mission-delivery-boundaries",
	"lifecycle",
	"scheduler-lifecycle",
	"ephemeral-defer",

	// Contracts and ephemeral establishment
	"contracts",
	"establishment-scope",
	"establishment-reaction",
	"establishment-delivery",
	"assigned-establishment",
	"ephemeral-staff-founding",

	// Virtual planning and proposal conversion
	"plan",
	"plan-snapshot",
	"plan-operations",
	"planned-scope",
	"warrant-discovery",
	"warrant-generation",
	"warrant-editing",
	"planned-reaction",
	"planned-messages",
	"planned-sending",
	"planned-defer",
	"proposal-work",
	"obligation-acceptance",
	"birth-proposals",
	"planned-establishment",
	"planned-founding",

	// Accepted work, publication and recovery
	"material-work",
	"materialization",
	"warrant-generation-recovery",
	"warrant-editing-protocols",
	"materialization-barrier",
	"warrant-write-barrier",
	"work-compatibility",
	"continuations",
	"event-publication",
	"event-acceptance",
	"event-failures",
	"recovery",
	"material-birth",

	// Continuation events and persistent execution
	"continuation-events",
	"continuation-cascade",
	"continuation-mixed",
	"continuation-activations",
	"continuation-establishment",
	"continuation-ephemeral",
	"persistent-reaction",
	"persistent-delivery",
	"persistent-tick",
	"persistent-birth-delivery",
	"assigned-persistent-founding",
	"establishment-effects",
	"persistent-protocols",
	"ephemeral-acknowledgement",

	// Runtime dispatch, lifecycle and reliability boundaries
	"runtime",
	"runtime-persistent",
	"runtime-messages",
	"message-dispatch",
	"runtime-defer",
	"mixed-ingress",
	"mixed-egress",
	"delivery-availability",
	"persistent-suspension",
	"persistent-resumption",

	// Administrative repair and obligation reporting
	"continuation-repair",
	"obligation-summary",

	// Custody, relocation and prototype receipts
	"local-custody",
	"custody-evidence",
	"custody-entry",
	"custody-transfer",
	"custody-roundtrip",
	"custody-binding",
	"custody-management",
	"prototype-wal-receipts",

	// Observation and durable notifications
	"observation",
	"mission-observation",
	"job-observation",
	"observation-preparation",
	"persistent-notifications",
	"persistent-observation",

	// Retention and collection
	"retention",
	"retention-integration",
	"collection",
	"collection-obligations",
	"automatic-collection",

	// TW5 management and presentation
	"management-work",
	"management",
	"management-integration",
	"management-lifecycle",
	"management-retention",
	"presentation-tree",
]);

function describe(error) {
	return String(error && error.stack || error);
}

function validateReport(report) {
	if (
		!report ||
		typeof report.passed !== "boolean" ||
		!Array.isArray(report.results) ||
		report.results.length === 0
	) {
		throw new Error("Suite returned an invalid or empty report");
	}

	var names = new Set();

	report.results.forEach(function (result) {
		if (
			!result ||
			typeof result.name !== "string" ||
			result.name.length === 0 ||
			typeof result.passed !== "boolean" ||
			(
				result.error !== null &&
				typeof result.error !== "string"
			)
		) {
			throw new Error("Suite returned an invalid test result");
		}

		if (names.has(result.name)) {
			throw new Error(
				"Suite returned duplicate test name: " + result.name
			);
		}

		names.add(result.name);
	});

	var passed = report.results.every(function (result) {
		return result.passed;
	});

	if (passed !== report.passed) {
		throw new Error("Suite summary contradicts its test results");
	}
}

function selectSuites(options) {
	if (options === undefined) {
		return SUITES.slice();
	}

	if (
		!options ||
		!Array.isArray(options.suites) ||
		options.suites.length === 0
	) {
		throw new Error("Test selection requires a non-empty suites array");
	}

	var selected = new Set();

	options.suites.forEach(function (name) {
		if (SUITES.indexOf(name) === -1) {
			throw new Error("Unknown test suite: " + name);
		}

		if (selected.has(name)) {
			throw new Error("Duplicate test suite selection: " + name);
		}

		selected.add(name);
	});

	// Keep the explanatory order of the complete suite.
	return SUITES.filter(function (name) {
		return selected.has(name);
	});
}

exports.list = function () {
	return SUITES.slice();
};

exports.run = async function (tw, options) {
	var selected = selectSuites(options);
	var results = [];
	var suites = [];

	for (var index = 0; index < selected.length; index++) {
		var name = selected[index];

		try {
			var module = require(PREFIX + name + ".js");

			if (typeof module.run !== "function") {
				throw new Error("Test suite must export run()");
			}

			/*
			Existing suites are synchronous. Await also permits
			future asynchronous infrastructure tests.
			*/
			var report = await module.run(tw);

			validateReport(report);

			report.results.forEach(function (result) {
				results.push({
					name: name + " :: " + result.name,
					passed: result.passed,
					error: result.error
				});
			});

			suites.push({
				name: name,
				passed: report.passed,
				count: report.results.length,
				error: null
			});
		} catch (error) {
			var diagnostic = describe(error);

			results.push({
				name: name + " :: suite failure",
				passed: false,
				error: diagnostic
			});

			suites.push({
				name: name,
				passed: false,
				count: 1,
				error: diagnostic
			});
		}
	}

	return {
		passed: results.every(function (result) {
			return result.passed;
		}),
		results: results,
		suites: suites
	};
};