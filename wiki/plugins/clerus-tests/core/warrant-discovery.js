/*\
title: $:/plugins/clerus/tests/core/warrant-discovery.js
type: application/javascript
module-type: library
\*/

"use strict";

var discovery = require(
	"$:/plugins/clerus/core/warrant-discovery.js"
);
var reactions = require("$:/plugins/clerus/core/reaction.js");
var plannedReactions = require(
	"$:/plugins/clerus/core/planned-reaction.js"
);
var plannedScopes = require(
	"$:/plugins/clerus/core/planned-scope.js"
);
var Plan = require("$:/plugins/clerus/core/plan.js").Plan;
var stores = require("$:/plugins/clerus/core/store.js");

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
		discover: [{
			name: "sources",
			filters: ["[tag[Source]sort[title]]"]
		}],
		generate: [],
		edit: []
	};
}

function fixture(tw, persistent) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var title = persistent
		? "$:/clerus/jobs/warrant-discovery"
		: "$:/temp/clerus/jobs/" + platform + "/warrant-discovery";

	[
		{ title: "Public/A", tags: "Source", text: "A" },
		{ title: "Private/B", tags: "Source", text: "B" },
		{ title: "Other", text: "other" },
		{ title: "$:/Hidden", tags: "Source" }
	].forEach(function (fields) {
		wiki.addTiddler(new tw.Tiddler(fields));
	});

	wiki.addTiddler(new tw.Tiddler({
		title: title,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "warrant-discovery",
		text: JSON.stringify({
			charter: { form: "charter", status: {} },
			access: warrant()
		})
	}));

	return {
		wiki: wiki,
		title: title,
		platform: platform,
		store: new stores.Store({
			wiki: wiki,
			Tiddler: tw.Tiddler
		})
	};
}

function testRestrictedEvaluator(tw) {
	var snapshot = {
		materialized: [
			{ title: "Public/A", tags: "Source" },
			{ title: "Private/B", tags: "Source" },
			{ title: "$:/Hidden", tags: "Source" }
		],
		shadows: [
			{ title: "Public/Shadow", tags: "Source" }
		]
	};

	function evaluate(filters) {
		return discovery.evaluate(snapshot, filters, {
			Wiki: tw.Wiki,
			Tiddler: tw.Tiddler
		});
	}

	assert(
		evaluate([
			"[tag[Source]sort[title]]",
			"[prefix[Public/]]"
		]).join(",") === "Public/A"
	);

	assert(evaluate(["[[Missing]]"]).length === 0);

	assert(
		evaluate(["[field:tags[Source]sort[title]]"])
			.join(",") === "Private/B,Public/A"
	);

	throws(function () {
		evaluate(["[all[shadows]]"]);
	}, "Unsupported warrant filter operator");

	throws(function () {
		evaluate(["[tag<currentTiddler>]"]);
	}, "literal operand");

	throws(function () {
		evaluate(["[tag{Configuration}]"]);
	}, "literal operand");

	throws(function () {
		evaluate(["[tag[Source]"]);
	}, "Invalid warrant discovery filter");
}

function testEphemeralCapture(tw) {
	var f = fixture(tw, false);

	reactions.execute({
		store: f.store,
		title: f.title,
		platform: f.platform,
		event: { type: "test" },

		handler: function (event, operational) {
			var access = operational.get("access");

			assert(
				access.select("sources").join(",") ===
					"Private/B,Public/A"
			);

			var restricted = access.narrow({
				discover: [{
					name: "sources",
					filters: ["[prefix[Public/]]"]
				}]
			}, operational, "restricted");

			var captured = restricted.capture(
				"sources",
				"Public/A",
				operational,
				"source"
			);

			assert(captured.text() === "A");

			operational.destroy("restricted");

			assert(captured.text() === "A");

			var before = f.wiki.getTiddler(f.title).fields.text;

			throws(function () {
				access.capture(
					"sources",
					"Other",
					operational,
					"denied"
				);
			}, "outside warrant");

			assert(
				f.wiki.getTiddler(f.title).fields.text === before
			);
		}
	});

	var registry = JSON.parse(
		f.wiki.getTiddler(f.title).fields.text
	);

	assert(registry.source === "Public/A");
	assert(!registry.denied);
}

function testCurrentPlanPerspective(tw) {
	var f = fixture(tw, true);
	var plan = new Plan(f.store.snapshot());

	var scope = plannedScopes.open({
		plan: plan,
		title: f.title,
		platform: f.platform,
		eventType: "test",
		filterWarrantSnapshot:
			f.store.filterWarrantSnapshot.bind(f.store)
	});

	try {
		var access = scope.operational.get("access");

		assert(access.select("sources").length === 2);

		var before = plan.read("Other").fields;
		var after = {
			title: "Other",
			text: "virtual",
			tags: "Source"
		};

		plan.apply(stores.transition("Other", before, after));

		assert(access.select("sources").indexOf("Other") !== -1);
		assert(!f.wiki.getTiddler("Other").hasTag("Source"));

		var captured = access.capture(
			"sources",
			"Other",
			scope.operational,
			"virtualSource"
		);

		assert(captured.text() === "virtual");

		var stored = JSON.parse(
			f.wiki.getTiddler(f.title).fields.text
		);

		assert(!stored.virtualSource);

		plan.apply(stores.transition(
			"Other",
			after,
			before
		));

		var effectsBefore = JSON.stringify(plan.export());

		throws(function () {
			access.capture(
				"sources",
				"Other",
				scope.operational,
				"staleSelection"
			);
		}, "outside warrant");

		assert(JSON.stringify(plan.export()) === effectsBefore);
		assert(
			scope.operational.keys().indexOf("staleSelection") === -1
		);
	} finally {
		scope.close();
		plan.abort();
	}
}

function testPlannedReactionWiring(tw) {
	var f = fixture(tw, true);
	var before = f.wiki.getTiddler(f.title).fields.text;

	var proposal = plannedReactions.execute({
		store: f.store,
		title: f.title,
		platform: f.platform,
		event: { type: "test" },

		handler: function (event, operational) {
			operational.get("access").capture(
				"sources",
				"Public/A",
				operational,
				"source"
			);
		}
	});

	assert(f.wiki.getTiddler(f.title).fields.text === before);

	var effect = proposal.plan.effects.find(function (entry) {
		return entry.title === f.title;
	});

	assert(effect);
	assert(JSON.parse(effect.after.text).source === "Public/A");
}

exports.run = function (tw) {
	var cases = [
		["warrant discovery: restricted filters and corpus", testRestrictedEvaluator],
		["warrant discovery: ephemeral capture and attenuation", testEphemeralCapture],
		["warrant discovery: current virtual state and revalidation", testCurrentPlanPerspective],
		["warrant discovery: planned reaction wiring", testPlannedReactionWiring]
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