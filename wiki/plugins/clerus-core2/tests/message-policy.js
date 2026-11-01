/*\
title: $:/plugins/clerus/core2/tests/message-policy.js
type: application/javascript
module-type: library
\*/

"use strict";

var policy = require(
	"$:/plugins/clerus/core2/message-policy.js"
);

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

function persistent(name) {
	return "$:/clerus/jobs/" + name;
}

function ephemeral(platform, name) {
	return "$:/temp/clerus/jobs/" + platform + "/" + name;
}

function fixture() {
	var director = persistent("policy-director");
	var manager = persistent("policy-manager");
	var worker = persistent("policy-worker");
	var peer = persistent("policy-peer");

	return {
		director: director,
		manager: manager,
		worker: worker,
		peer: peer,

		jobs: [
			{
				title: director,
				custody: "node",
				registry: { manager: manager }
			},
			{
				title: manager,
				custody: "browser",
				registry: {
					worker: worker,
					peer: peer
				}
			},
			{
				title: worker,
				custody: "node",
				registry: {}
			},
			{
				title: peer,
				custody: "user",
				registry: {}
			}
		]
	};
}

function check(f, registry, extra) {
	return policy.check(Object.assign({
		type: "order",
		platform: "browser",
		source: f.manager,
		recipient: f.worker,
		jobs: f.jobs,
		registry: registry
	}, extra || {}));
}

function testOrdinaryDocuments() {
	var f = fixture();

	var source = {
		note: {
			form: "memo",
			data: {
				embeddedTitle: f.director
			}
		},
		document: "Ordinary Document",
		peer: f.peer
	};

	var result = check(f, source);

	assert(result.registry.peer === f.peer);

	result.registry.note.data.embeddedTitle = "local";

	assert(source.note.data.embeddedTitle === f.director);
}

function testSelfAndSuperiors() {
	var f = fixture();

	[f.worker, f.manager, f.director].forEach(function (title) {
		throws(function () {
			check(f, { forbidden: title });
		}, "recipient or its superior");
	});
}

function testImmediateRelationship() {
	var f = fixture();

	throws(function () {
		check(f, {}, {
			source: f.director,
			recipient: f.worker
		});
	}, "immediate subordination");

	throws(function () {
		check(f, {}, {
			source: f.worker,
			recipient: f.peer
		});
	}, "immediate subordination");
}

function testMixedDurability() {
	var superior = persistent("mixed-superior");
	var subordinate = ephemeral("browser", "mixed-subordinate");

	var jobs = [
		{
			title: superior,
			registry: { subordinate: subordinate }
		},
		{
			title: subordinate,
			registry: {}
		}
	];

	var base = {
		type: "order",
		platform: "browser",
		source: superior,
		recipient: subordinate,
		jobs: jobs
	};

	assert(policy.check(Object.assign({}, base, {
		registry: {
			note: { form: "memo", data: 1 }
		}
	})));

	throws(function () {
		policy.check(Object.assign({}, base, {
			registry: {
				title: persistent("another")
			}
		}));
	}, "cannot receive persistent job titles");
}

function testPlatformBoundary() {
	var superior = persistent("local-superior");
	var subordinate = ephemeral("node", "foreign-subordinate");

	throws(function () {
		policy.check({
			type: "order",
			platform: "browser",
			source: superior,
			recipient: subordinate,
			jobs: [
				{
					title: superior,
					registry: { subordinate: subordinate }
				},
				{
					title: subordinate,
					registry: {}
				}
			],
			registry: {}
		});
	}, "cannot cross platforms");
}

function testIncompleteHierarchy() {
	var f = fixture();

	f.jobs.push({
		title: persistent("unreadable"),
		registry: null
	});

	throws(function () {
		check(f, {});
	}, "incomplete hierarchy");
}

function testUnconnectedPathsAreRejected() {
	var f = fixture();

	throws(function () {
		check(f, {}, {
			type: "report",
			source: f.worker,
			recipient: f.manager
		});
	}, "Report assignment authorization");

	throws(function () {
		check(f, {
			mission: {
				form: "mission",
				project: "Policy Project",
				role: ["item"],
				link: "10/1",
				issued: "0",
				children: {}
			}
		});
	}, "Mission transmission authorization");
}

exports.run = function () {
	var cases = [
		["message policy: ordinary documents and isolation", testOrdinaryDocuments],
		["message policy: recipient and superiors are protected", testSelfAndSuperiors],
		["message policy: relationship must be immediate", testImmediateRelationship],
		["message policy: mixed durability is supported", testMixedDurability],
		["message policy: platform boundary is enforced", testPlatformBoundary],
		["message policy: incomplete hierarchy prevents sending", testIncompleteHierarchy],
		["message policy: unfinished authorization paths are blocked", testUnconnectedPathsAreRejected]
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