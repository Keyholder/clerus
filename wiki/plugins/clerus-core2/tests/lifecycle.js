/*\
title: $:/plugins/clerus/core/tests/lifecycle.js
type: application/javascript
module-type: library
\*/

"use strict";

var lifecycle = require("$:/plugins/clerus/core/lifecycle.js");
var Store = require("$:/plugins/clerus/core/store.js").Store;
var missions = require("$:/plugins/clerus/core/missions.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw, recorder) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var prefix = "$:/temp/clerus/jobs/" + platform + "/";
	var owner = prefix + "failed-owner";
	var subordinate = prefix + "lower-owner";
	var project = "Core2 Lifecycle Project";
	var incidents = [];

	function write(title, executor, registry) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": platform,
			"clerus-executor": executor,
			caption: "Preserved",
			text: JSON.stringify(registry)
		}));
	}

	write(owner, "failing-executor", {
		charter: {
			form: "charter",
			status: { phase: "working" }
		},
		mission: {
			form: "mission",
			project: project,
			role: [],
			link: "10",
			issued: "1",
			children: { item: "10/1" }
		},
		subordinate: subordinate
	});

	write(subordinate, "lower-executor", {
		charter: {
			form: "charter",
			status: {}
		},
		mission: {
			form: "mission",
			project: project,
			role: ["item"],
			link: "10/1",
			issued: "0",
			children: {}
		}
	});

	var store = new Store({
		wiki: wiki,
		Tiddler: tw.Tiddler
	});

	var service = lifecycle.create({
		store: store,
		platform: platform,

		recordIncident: function (incident) {
			if (recorder) {
				return recorder(incident, wiki, owner);
			}

			incidents.push(incident);
			return "$:/test/incidents/" + incidents.length;
		}
	});

	return {
		wiki: wiki,
		owner: owner,
		subordinate: subordinate,
		incidents: incidents,

		dismiss: function () {
			return service.dismiss({
				title: owner,
				executor: "failing-executor",
				event: { type: "test" },
				error: new Error("Executor failed")
			});
		},

		evaluate: function () {
			return missions.evaluate(
				[owner, subordinate].map(function (title) {
					var tiddler = wiki.getTiddler(title);

					return {
						title: title,
						custody: tiddler.fields["clerus-custody"],
						registry: JSON.parse(tiddler.fields.text)
					};
				})
			);
		}
	};
}

function testDocumentsRemainUntouched(tw) {
	var f = fixture(tw);
	var before = f.wiki.getTiddler(f.owner).fields.text;
	var lowerBefore = f.wiki.getTiddler(f.subordinate).fields.text;

	assert(f.evaluate().active.length === 2);

	var result = f.dismiss();

	assert(result.dismissed);
	assert(result.incident === "$:/test/incidents/1");
	assert(result.incidentError === null);
	assert(result.transitionError === null);

	var current = f.wiki.getTiddler(f.owner);

	assert(current.fields["clerus-custody"] === "user");
	assert(current.fields.text === before);
	assert(current.fields.caption === "Preserved");

	assert(
		f.wiki.getTiddler(f.subordinate).fields.text === lowerBefore
	);

	var perspective = f.evaluate();

	assert(perspective.active.length === 0);
	assert(perspective.hierarchy.edges.length === 1);

	assert(f.incidents[0].error.message === "Executor failed");
	assert(f.incidents[0].event.type === "test");
}

function testRecorderFailureDoesNotPreventDismissal(tw) {
	var f = fixture(tw, function () {
		throw new Error("Incident storage unavailable");
	});

	var result = f.dismiss();

	assert(result.dismissed);
	assert(result.incident === null);
	assert(
		result.incidentError.message ===
			"Incident storage unavailable"
	);
	assert(
		f.wiki.getTiddler(f.owner)
			.fields["clerus-custody"] === "user"
	);
}

function testInterventionIsNotOverwritten(tw) {
	var f = fixture(tw, function (incident, wiki, owner) {
		wiki.addTiddler(new tw.Tiddler(
			wiki.getTiddler(owner),
			{ caption: "Intervention" }
		));

		return "$:/test/incidents/intervention";
	});

	var result = f.dismiss();

	assert(!result.dismissed);
	assert(result.reason === "transition-failed");
	assert(result.transitionError);

	assert(
		f.wiki.getTiddler(f.owner).fields.caption === "Intervention"
	);
}

function testMalformedRegistryDoesNotBlockTransfer(tw) {
	var f = fixture(tw);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.owner),
		{ text: "not JSON" }
	));

	var result = f.dismiss();

	assert(result.dismissed);
	assert(f.wiki.getTiddler(f.owner).fields.text === "not JSON");
}

function testChangedExecutorIsNotDismissed(tw) {
	var f = fixture(tw);

	f.wiki.addTiddler(new tw.Tiddler(
		f.wiki.getTiddler(f.owner),
		{ "clerus-executor": "replacement" }
	));

	var result = f.dismiss();

	assert(!result.dismissed);
	assert(result.reason === "executor-changed");
	assert(result.incident);
}

function testFailureBeforeBirth(tw) {
	var f = fixture(tw);

	f.wiki.deleteTiddler(f.owner);

	var result = f.dismiss();

	assert(!result.dismissed);
	assert(result.reason === "job-not-materialized");
	assert(result.incident);
	assert(!f.wiki.getTiddler(f.owner));
}

exports.run = function (tw) {
	var cases = [
		["lifecycle: documents remain untouched while authority expires", testDocumentsRemainUntouched],
		["lifecycle: incident failure does not prevent dismissal", testRecorderFailureDoesNotPreventDismissal],
		["lifecycle: intervention is not overwritten", testInterventionIsNotOverwritten],
		["lifecycle: malformed registry remains intact", testMalformedRegistryDoesNotBlockTransfer],
		["lifecycle: replacement executor is protected", testChangedExecutorIsNotDismissed],
		["lifecycle: failure before birth records only an incident", testFailureBeforeBirth]
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