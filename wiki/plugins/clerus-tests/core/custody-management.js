/*\
title: $:/plugins/clerus/tests/core/custody-management.js
type: application/javascript
module-type: library
\*/

"use strict";

var apiModule = require("$:/plugins/clerus/core/api.js");
var custodySchema = require(
	"$:/plugins/clerus/core/custody-schema.js"
);

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw, nested) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var source = platform === "browser" ? "node" : "browser";
	var journal = "$:/clerus/wal/" + source + "/management-unique";
	var target = "$:/clerus/jobs/custody-management-target";
	var sequence = 0;
	var calls = 0;
	var nestedRejected = false;
	var api;

	wiki.addTiddler(new tw.Tiddler({
		title: target,
		type: "application/json",
		"clerus-custody": platform,
		"clerus-executor": "management-test",
		"clerus-custody-transfer": JSON.stringify({
			version: 1,
			journal: journal,
			work: "management-transfer-work-01",
			from: source,
			to: platform
		}),
		text: JSON.stringify({
			charter: {
				form: "charter",
				status: {}
			}
		})
	}));

	function createAPI() {
		return apiModule.create({
			wiki: wiki,
			Tiddler: tw.Tiddler,
			platform: platform,
			newId: function () {
				sequence++;
				return "management-generated-" +
					String(sequence).padStart(12, "0");
			},
			resolveExecutor: function () {
				return function (event, operational) {
					calls++;

					if (nested) {
						try {
							api.recordWalDeletion(journal);
						} catch (error) {
							nestedRejected = (
								error.message.indexOf(
									"during execution"
								) !== -1
							);
						}

						return;
					}

					operational.get("charter").setStatus({
						phase: "written"
					});
				};
			}
		});
	}

	api = createAPI();

	return {
		wiki: wiki,
		platform: platform,
		journal: journal,
		target: target,
		api: api,
		restart: createAPI,
		calls: function () {
			return calls;
		},
		nestedRejected: function () {
			return nestedRejected;
		}
	};
}

function testRecordingDoesNotInvokeExecutor(tw) {
	var f = fixture(tw, false);

	var recorded = f.api.recordWalDeletion(f.journal);

	assert(recorded.status === "recorded");
	assert(f.calls() === 0);
	assert(f.wiki.tiddlerExists(f.target));

	var repeated = f.api.recordWalDeletion(f.journal);

	assert(repeated.status === "already-recorded");
	assert(repeated.title === recorded.title);
	assert(f.calls() === 0);

	var restarted = f.restart();
	var result = restarted.dispatch(
		f.target,
		{ type: "test" }
	);

	assert(result.status === "completed");
	assert(f.calls() === 1);
	assert(
		JSON.parse(f.wiki.getTiddlerText(f.target))
			.charter.status.phase === "written"
	);
}

function testNestedRecordingIsRejected(tw) {
	var f = fixture(tw, true);

	var result = f.api.dispatch(
		f.target,
		{ type: "test" }
	);

	assert(result.status === "completed");
	assert(f.calls() === 1);
	assert(f.nestedRejected());

	var evidenceTitle = custodySchema.deletionTitle(
		f.platform,
		f.journal
	);

	assert(!f.wiki.tiddlerExists(evidenceTitle));
}

exports.run = function (tw) {
	var cases = [
		["public evidence input invokes no executor", testRecordingDoesNotInvokeExecutor],
		["executor cannot use the environment input reentrantly", testNestedRecordingIsRejected]
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