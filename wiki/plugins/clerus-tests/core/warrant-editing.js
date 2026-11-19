/*\
title: $:/plugins/clerus/tests/core/warrant-editing.js
type: application/javascript
module-type: library
\*/

"use strict";

var warrants = require(
	"$:/plugins/clerus/core/warrant-schema.js"
);
var reactions = require("$:/plugins/clerus/core/reaction.js");
var planned = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
var scopes = require("$:/plugins/clerus/core/scope.js");
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

function warrant() {
	return {
		form: "warrant",
		discover: [],
		generate: [],
		edit: [{
			name: "annotate",
			target: { titlePrefix: "Research/" },
			setFields: ["text", "research-summary"],
			removeFields: ["research-summary"]
		}]
	};
}

function fixture(tw, persistent, targetCustody) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = persistent
		? "$:/clerus/jobs/warrant-editing"
		: "$:/temp/clerus/jobs/" + platform + "/warrant-editing";

	var target = "Research/Source";

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		"clerus-custody": targetCustody || platform,
		text: "Original",
		"research-summary": "Old"
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: "Other/Source",
		"clerus-custody": platform,
		text: "Outside"
	}));

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "warrant-editing",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			access: warrant(),
			source: target,
			outside: "Other/Source"
		})
	}));

	return {
		wiki: wiki,
		title: title,
		target: target,
		platform: platform,
		store: new Store({
			wiki: wiki,
			Tiddler: tw.Tiddler
		})
	};
}

function execute(f, handler) {
	return reactions.execute({
		store: f.store,
		title: f.title,
		platform: f.platform,
		event: { type: "test" },
		handler: handler
	});
}

function testNarrowing() {
	var restricted = warrants.narrow(warrant(), {
		edit: [{
			name: "annotate",
			target: { titlePrefix: "Research/Public/" },
			setFields: ["research-summary"],
			removeFields: []
		}]
	});

	assert(restricted.edit[0].setFields.length === 1);
	assert(restricted.edit[0].removeFields.length === 0);

	throws(function () {
		warrants.narrow(restricted, {
			edit: [{
				name: "annotate",
				target: { titlePrefix: "Research/" }
			}]
		});
	}, "cannot be widened");

	throws(function () {
		warrants.narrow(restricted, {
			edit: [{
				name: "annotate",
				setFields: ["text"]
			}]
		});
	}, "cannot be widened");

	var invalid = warrant();
	invalid.edit[0].setFields.push("clerus-custody");

	throws(function () {
		warrants.validate(invalid);
	}, "Invalid warrant editing field");
}

function testEphemeralEditing(tw) {
	var f = fixture(tw, false);

	execute(f, function (event, operational) {
		var access = operational.get("access");
		var source = operational.get("source");

		access.apply("annotate", source, {
			set: { text: "Changed" },
			remove: ["research-summary"]
		});

		assert(source.text() === "Changed");
		assert(source.field("clerus-custody") === f.platform);
	});

	var fields = f.wiki.getTiddler(f.target).fields;

	assert(fields.text === "Changed");
	assert(!Object.prototype.hasOwnProperty.call(
		fields,
		"research-summary"
	));
}

function testRejectedEdits(tw) {
	var f = fixture(tw, false);

	execute(f, function (event, operational) {
		var access = operational.get("access");
		var source = operational.get("source");
		var before = JSON.stringify(f.store.snapshot());

		throws(function () {
			access.apply("annotate", source, {
				set: { caption: "Not allowed" }
			});
		}, "not allowed");

		throws(function () {
			access.apply("annotate", source, {
				set: { text: "Changed" },
				remove: ["text"]
			});
		}, "same field");

		throws(function () {
			access.apply(
				"annotate",
				operational.get("outside"),
				{ set: { text: "Changed" } }
			);
		}, "outside warrant");

		throws(function () {
			access.apply(
				"annotate",
				f.target,
				{ set: { text: "Changed" } }
			);
		}, "title instrument from this scope");

		assert(JSON.stringify(f.store.snapshot()) === before);
	});
}

function testForeignInstrument(tw) {
	var f = fixture(tw, false);

	var other = scopes.open({
		operational: {
			charter: { form: "charter", status: {} },
			source: f.target
		}
	});

	try {
		execute(f, function (event, operational) {
			throws(function () {
				operational.get("access").apply(
					"annotate",
					other.operational.get("source"),
					{ set: { text: "Changed" } }
				);
			}, "title instrument from this scope");
		});
	} finally {
		other.close();
	}
}

function testCustody(tw) {
	var f = fixture(tw, false, "user");

	execute(f, function (event, operational) {
		throws(function () {
			operational.get("access").apply(
				"annotate",
				operational.get("source"),
				{ set: { text: "Changed" } }
			);
		}, "not owned by this platform");
	});

	assert(f.wiki.getTiddler(f.target).fields.text === "Original");
}

function testPlannedEditing(tw) {
	var f = fixture(tw, true);

	var proposal = planned.execute({
		store: f.store,
		title: f.title,
		platform: f.platform,
		event: { type: "test" },

		handler: function (event, operational) {
			var access = operational.get("access");
			var source = operational.get("source");

			access.apply("annotate", source, {
				set: { text: "Intermediate" }
			});

			assert(source.text() === "Intermediate");

			access.apply("annotate", source, {
				set: { text: "Final" }
			});

			assert(source.text() === "Final");
			assert(
				f.wiki.getTiddler(f.target).fields.text ===
					"Original"
			);

			var before = source.text();

			throws(function () {
				access.apply("annotate", source, {
					set: { caption: "Denied" }
				});
			}, "not allowed");

			assert(source.text() === before);
		}
	});

	assert(proposal.plan.effects.length === 1);

	var effect = proposal.plan.effects[0];

	assert(effect.title === f.target);
	assert(effect.before.text === "Original");
	assert(effect.after.text === "Final");
	assert(f.wiki.getTiddler(f.target).fields.text === "Original");
}

exports.run = function (tw) {
	var cases = [
		["warrant editing: schema and attenuation", testNarrowing],
		["warrant editing: ephemeral set and removal", testEphemeralEditing],
		["warrant editing: rejected changes are atomic", testRejectedEdits],
		["warrant editing: foreign instruments are rejected", testForeignInstrument],
		["warrant editing: custody is independently required", testCustody],
		["warrant editing: planned changes collapse to final state", testPlannedEditing]
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