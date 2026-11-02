/*\
title: $:/plugins/clerus/core2/tests/collection.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core2/runtime.js").Runtime;
var collection = require("$:/plugins/clerus/core2/collection.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function fixture(tw) {
	var wiki = new tw.Wiki();
	var platform = tw.browser ? "browser" : "node";
	var sequence = 0;

	var runtime = new Runtime({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,

		newId: function () {
			sequence++;

			return "collection-test-" +
				String(sequence).padStart(12, "0");
		},

		resolveExecutor: function () {
			return function (event, operational) {
				if (event.type === "defer") {
					operational.get("charter").defer();
				}
			};
		}
	});

	function write(title, extra, custody) {
		wiki.addTiddler(new tw.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": custody || platform,
			"clerus-executor": "collection-test",

			text: JSON.stringify(Object.assign({
				charter: { form: "charter", status: {} }
			}, extra || {}))
		}));
	}

	return {
		wiki: wiki,
		platform: platform,
		runtime: runtime,
		write: write
	};
}

function testOrganizationIsReleasedInPasses(tw) {
	var f = fixture(tw);
	var root = "$:/clerus/jobs/collection-root";
	var child =
		"$:/temp/clerus/jobs/" + f.platform + "/collection-child";
	var leaf = child + "/leaf";

	f.write(root, { child: child });
	f.write(child, { leaf: leaf });
	f.write(leaf);

	var first = f.runtime.collect();

	assert(first.removed.join(",") === root);
	assert(f.wiki.getTiddler(child));
	assert(f.wiki.getTiddler(leaf));

	var second = f.runtime.collect();

	assert(second.removed.join(",") === child);
	assert(f.wiki.getTiddler(leaf));

	var third = f.runtime.collect();

	assert(third.removed.join(",") === leaf);
	assert(f.runtime.readJobs().length === 0);
}

function testCustodyIsSeparateFromCandidacy(tw) {
	var f = fixture(tw);
	var title = "$:/clerus/jobs/collection-user-owned";

	f.write(title, {}, "user");

	assert(
		f.runtime.inspect().retention.candidates.includes(title)
	);

	var result = f.runtime.collect();

	assert(result.removed.length === 0);
	assert(result.skipped[0].reason === "not-locally-owned");
	assert(f.wiki.getTiddler(title));
}

function testActiveMissionPreventsCollection(tw) {
	var f = fixture(tw);
	var title = "$:/clerus/jobs/collection-director";

	f.write(title, {
		mission: {
			form: "mission",
			project: "Absent Collection Project",
			role: [],
			link: "10",
			issued: "0",
			children: {}
		}
	});

	var result = f.runtime.collect();

	assert(result.removed.length === 0);
	assert(result.blocked.length === 0);
	assert(f.wiki.getTiddler(title));
}

function testEphemeralTickBlocksCollection(tw) {
	var f = fixture(tw);
	var title =
		"$:/temp/clerus/jobs/" + f.platform + "/collection-ticker";

	f.write(title);

	f.runtime.dispatch(title, { type: "defer" });

	var blocked = f.runtime.collect();

	assert(blocked.removed.length === 0);
	assert(blocked.blocked.includes("ephemeral-ticks-pending"));

	f.runtime.runDeferred();

	var completed = f.runtime.collect();

	assert(completed.removed.join(",") === title);
}

function testNewReferenceProtectsCandidate(tw) {
	var f = fixture(tw);
	var target = "$:/clerus/jobs/a-collection-target";
	var holder = "$:/clerus/jobs/z-collection-holder";

	f.write(target);

	f.write(holder, {
		mission: {
			form: "mission",
			project: "Collection Holder Project",
			role: [],
			link: "10",
			issued: "0",
			children: {}
		}
	});

	var checks = 0;

	var result = collection.collect({
		store: f.runtime.store,
		platform: f.platform,
		readJobs: f.runtime.readJobs,

		guard: function () {
			checks++;

			if (checks === 2) {
				var current = f.wiki.getTiddler(holder);
				var registry = JSON.parse(current.fields.text);

				registry.target = target;

				f.wiki.addTiddler(new tw.Tiddler(
					current,
					{ text: JSON.stringify(registry) }
				));
			}

			return [];
		}
	});

	assert(result.removed.length === 0);
	assert(result.skipped[0].reason === "retained-or-absent");
	assert(f.wiki.getTiddler(target));
}

function testIncompleteKnowledgeStopsCollection(tw) {
	var f = fixture(tw);
	var title = "$:/clerus/jobs/collection-unused";

	f.write(title);

	f.wiki.addTiddler(new tw.Tiddler({
		title: "$:/clerus/wal/" + f.platform + "/unknown",
		type: "application/json",
		"clerus-custody": "user",
		"clerus-wal-kind": "unknown",
		text: JSON.stringify({
			version: 1,
			kind: "unknown",
			platform: f.platform
		})
	}));

	var result = f.runtime.collect();

	assert(result.removed.length === 0);
	assert(result.blocked.includes("incomplete-retention"));
	assert(f.wiki.getTiddler(title));
}

exports.run = function (tw) {
	var cases = [
		["collection: organization is released over separate passes", testOrganizationIsReleasedInPasses],
		["collection: custody is separate from candidacy", testCustodyIsSeparateFromCandidacy],
		["collection: active mission protects the owner", testActiveMissionPreventsCollection],
		["collection: ephemeral tick blocks deletion", testEphemeralTickBlocksCollection],
		["collection: fresh reference protects an initial candidate", testNewReferenceProtectsCandidate],
		["collection: incomplete knowledge prevents deletion", testIncompleteKnowledgeStopsCollection]
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