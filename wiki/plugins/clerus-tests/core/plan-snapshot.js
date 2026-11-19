/*\
title: $:/plugins/clerus/tests/core/plan-snapshot.js
type: application/javascript
module-type: library
\*/

"use strict";

var Plan = require("$:/plugins/clerus/core/plan.js").Plan;
var transition = require(
	"$:/plugins/clerus/core/store.js"
).transition;

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

function fixture() {
	return new Plan({
		materialized: [
			{ title: "Z", text: "original" },
			{ title: "Override", text: "materialized" }
		],
		shadows: [
			{ title: "Shadow", text: "shadow only" },
			{ title: "Override", text: "underlying shadow" }
		]
	});
}

function testCurrentState() {
	var plan = fixture();

	try {
		plan.apply(transition(
			"Z",
			{ title: "Z", text: "original" },
			{ title: "Z", text: "changed" }
		));

		plan.apply(transition(
			"A",
			null,
			{ title: "A", text: "created" }
		));

		var before = JSON.stringify(plan.export());
		var revision = plan.revision;
		var snapshot = plan.snapshot();

		assert(
			snapshot.materialized.map(function (fields) {
				return fields.title;
			}).join(",") === "A,Override,Z"
		);

		assert(snapshot.materialized[2].text === "changed");
		assert(snapshot.shadows.length === 2);
		assert(plan.initial("Z").text === "original");

		assert(JSON.stringify(plan.export()) === before);
		assert(plan.revision === revision);
	} finally {
		plan.abort();
	}
}

function testIsolatedValues() {
	var plan = fixture();

	try {
		var snapshot = plan.snapshot();

		snapshot.materialized[0].text = "local mutation";
		snapshot.shadows[0].text = "local mutation";
		snapshot.materialized.length = 0;
		snapshot.shadows.length = 0;

		assert(plan.read("Z").fields.text === "original");
		assert(plan.read("Override").fields.text === "materialized");
		assert(plan.read("Shadow").fields.text === "shadow only");

		var fresh = plan.snapshot();

		assert(fresh.materialized.length === 2);
		assert(fresh.shadows.length === 2);
		assert(fresh.shadows[0].text === "underlying shadow");
	} finally {
		plan.abort();
	}
}

function testBranchState() {
	var plan = fixture();

	try {
		plan.transact(function (branch) {
			branch.apply(transition(
				"Z",
				{ title: "Z", text: "original" },
				{ title: "Z", text: "branch" }
			));

			assert(branch.read("Z").fields.text === "branch");
			assert(plan.read("Z").fields.text === "original");

			var snapshot = branch.snapshot();

			var changed = snapshot.materialized.find(function (fields) {
				return fields.title === "Z";
			});

			assert(changed.text === "branch");
		});

		assert(plan.read("Z").fields.text === "branch");

		throws(function () {
			plan.transact(function (branch) {
				branch.apply(transition(
					"Z",
					{ title: "Z", text: "branch" },
					{ title: "Z", text: "discarded" }
				));

				assert(
					branch.snapshot().materialized.find(
						function (fields) {
							return fields.title === "Z";
						}
					).text === "discarded"
				);

				throw new Error("Discard branch");
			});
		}, "Discard branch");

		assert(plan.read("Z").fields.text === "branch");
	} finally {
		plan.abort();
	}
}

function testMaterializedDeletion() {
	var plan = fixture();

	try {
		plan.apply(transition(
			"Z",
			{ title: "Z", text: "original" },
			null
		));

		assert(plan.read("Z").kind === "absent");

		assert(
			!plan.snapshot().materialized.some(function (fields) {
				return fields.title === "Z";
			})
		);

		assert(plan.snapshot().shadows.length === 2);
	} finally {
		plan.abort();
	}
}

function testClosedPlan() {
	var aborted = fixture();
	aborted.abort();

	throws(function () {
		aborted.snapshot();
	}, "not open");

	var sealed = fixture();
	sealed.seal();

	throws(function () {
		sealed.snapshot();
	}, "not open");
}

exports.run = function () {
	var cases = [
		["plan snapshot: current state and stable ordering", testCurrentState],
		["plan snapshot: values are isolated", testIsolatedValues],
		["plan snapshot: branch acceptance and rejection", testBranchState],
		["plan snapshot: deleted materialized records disappear", testMaterializedDeletion],
		["plan snapshot: closed plans cannot be inspected", testClosedPlan]
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