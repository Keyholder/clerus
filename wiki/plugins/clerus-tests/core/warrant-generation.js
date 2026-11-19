/*\
title: $:/plugins/clerus/tests/core/warrant-generation.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var generation = require(
	"$:/plugins/clerus/core/warrant-generation.js"
);
var warrants = require(
	"$:/plugins/clerus/core/warrant-schema.js"
);
var reactions = require("$:/plugins/clerus/core/reaction.js");
var planned = require("$:/plugins/clerus/core/planned-reaction.js");
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
		generate: [{
			name: "note",
			titlePrefix: "Generated/",
			fields: {
				type: "text/plain",
				tags: "Generated"
			},
			inputFields: ["text", "caption"]
		}],
		edit: []
	};
}

function fixture(tw, persistent) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = persistent
		? "$:/clerus/jobs/warrant-generation"
		: "$:/temp/clerus/jobs/" + platform + "/warrant-generation";

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "warrant-generation",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			access: warrant()
		})
	}));

	return {
		wiki: wiki,
		title: title,
		platform: platform,
		store: new Store({
			wiki: wiki,
			Tiddler: tw.Tiddler
		})
	};
}

function testSchemaAndNarrowing() {
	assert(schemas.formOf(warrant()) === "warrant");

	var restricted = warrants.narrow(warrant(), {
		generate: [{
			name: "note",
			titlePrefix: "Generated/Public/",
			inputFields: ["text"]
		}]
	});

	assert(
		restricted.generate[0].titlePrefix === "Generated/Public/"
	);
	assert(restricted.generate[0].inputFields.join(",") === "text");

	throws(function () {
		warrants.narrow(restricted, {
			generate: [{
				name: "note",
				titlePrefix: "Generated/"
			}]
		});
	}, "cannot be widened");

	throws(function () {
		warrants.narrow(restricted, {
			generate: [{
				name: "note",
				inputFields: ["text", "caption"]
			}]
		});
	}, "cannot be widened");

	var invalid = warrant().generate[0];
	invalid.fields["clerus-custody"] = "user";

	throws(function () {
		generation.validate(invalid);
	}, "Invalid warrant generation field");
}

function testEphemeralCreation(tw) {
	var f = fixture(tw, false);

	reactions.execute({
		store: f.store,
		title: f.title,
		platform: f.platform,
		event: { type: "test" },
		newId: function () {
			return "one";
		},

		handler: function (event, operational) {
			var created = operational.get("access").generate(
				"note",
				{ text: "Hello" },
				operational,
				"created"
			);

			assert(created.text() === "Hello");
			assert(created.field("clerus-custody") === f.platform);
			assert(created.field("type") === "text/plain");
		}
	});

	assert(f.wiki.getTiddler("Generated/one"));

	assert(
		JSON.parse(f.wiki.getTiddler(f.title).fields.text)
			.created === "Generated/one"
	);
}

function testPlannedCreation(tw) {
	var f = fixture(tw, true);
	var before = f.wiki.getTiddler(f.title).fields.text;

	var proposal = planned.execute({
		store: f.store,
		title: f.title,
		platform: f.platform,
		event: { type: "test" },
		newId: function () {
			return "planned";
		},

		handler: function (event, operational) {
			var created = operational.get("access").generate(
				"note",
				{ text: "Virtual" },
				operational,
				"created"
			);

			assert(created.text() === "Virtual");
			assert(!f.wiki.getTiddler("Generated/planned"));
		}
	});

	assert(!f.wiki.getTiddler("Generated/planned"));
	assert(f.wiki.getTiddler(f.title).fields.text === before);
	assert(proposal.plan.effects.length === 2);

	var creation = proposal.plan.effects.find(function (effect) {
		return effect.title === "Generated/planned";
	});

	assert(creation.before === null);
	assert(creation.after.text === "Virtual");
	assert(creation.after["clerus-custody"] === f.platform);
}

function testRejectedInputsAndCollision(tw) {
	var f = fixture(tw, false);
	var allocated = 0;

	f.wiki.addTiddler(new tw.Tiddler({
		title: "Generated/occupied",
		text: "Original"
	}));

	reactions.execute({
		store: f.store,
		title: f.title,
		platform: f.platform,
		event: { type: "test" },

		newId: function () {
			allocated++;
			return "occupied";
		},

		handler: function (event, operational) {
			var access = operational.get("access");
			var before = f.wiki.getTiddler(f.title).fields.text;

			throws(function () {
				access.generate("note", {
					"clerus-custody": "user"
				}, operational, "denied");
			}, "not allowed");

			assert(allocated === 0);

			throws(function () {
				access.generate(
					"note",
					{ text: "Overwrite" },
					operational,
					"collision"
				);
			}, "occupied");

			assert(allocated === 1);
			assert(
				f.wiki.getTiddler(f.title).fields.text === before
			);
			assert(
				f.wiki.getTiddler("Generated/occupied").fields.text ===
					"Original"
			);
		}
	});
}

exports.run = function (tw) {
	var cases = [
		["warrant generation: schema and attenuation", testSchemaAndNarrowing],
		["warrant generation: ephemeral creation and title", testEphemeralCreation],
		["warrant generation: virtual creation is compiled", testPlannedCreation],
		["warrant generation: bad input and collision leave no proposal", testRejectedInputsAndCollision]
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