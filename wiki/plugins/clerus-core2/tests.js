/*\
title: $:/plugins/clerus/core2/tests.js
type: application/javascript
module-type: library
\*/

"use strict";

var PREFIX = "$:/plugins/clerus/core2/tests/";

var SUITES = Object.freeze([
	"foundation",
	"scope",
	"operations",
	"document-updates",
	"reaction",
	"observation",
	"integration",

	"mission-foundation",
	"hierarchy",
	"missions",
	"mission-issuance",
	"mission-scope",
	"project-perspective",
	"mission-reaction",
	"mission-mutations",
	"mission-transactions",

	"job-titles",
	"organization",
	"message-policy",
	"orders",
	"scheduler",
	"reports",
	"mission-delivery",
	"mission-delivery-boundaries",

	"title-issuance",
	"contracts",
	"establishment-scope",
	"establishment-reaction",
	"establishment-delivery",
	"assigned-establishment",

	"lifecycle",
	"scheduler-lifecycle",
	"runtime",

    "plan",
    "plan-operations",
    "planned-messages",
    "flow-schema",
    "flow-materialization",
    "flow-acceptance",
    "flow-failures",
    "planned-scope",
    "planned-reaction",
    "planned-sending",
    "obligation-acceptance",
    "materialization",
    "materialization-barrier",
    "persistent-reaction",
    "persistent-flow-reaction",
    "flow-scheduler",
    "runtime-flows",
    "persistent-protocols",
    "mixed-ingress",
    "ephemeral-acknowledgement",
    "mixed-egress",
    "recovery",
    "runtime-persistent",
    "persistent-suspension",
    "persistent-resumption"
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