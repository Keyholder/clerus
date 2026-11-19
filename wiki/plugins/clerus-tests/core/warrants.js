/*\
title: $:/plugins/clerus/tests/core/warrants.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var warrants = require(
	"$:/plugins/clerus/core/warrant-schema.js"
);
var scopes = require("$:/plugins/clerus/core/scope.js");

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
		binding: {
			project: "Research",
			role: [],
			link: "1"
		},
		discover: [
			{
				name: "sources",
				filters: ["[tag[Source]]"]
			},
			{
				name: "notes",
				filters: ["[tag[Note]]"]
			}
		],
		generate: [],
		edit: []
	};
}

function open() {
	return scopes.open({
		operational: {
			charter: {
				form: "charter",
				status: {}
			}
		},
		incoming: {
			warrant: warrant()
		}
	});
}

function testSchema() {
	var source = warrant();

	assert(schemas.formOf(source) === "warrant");

	var normalized = warrants.validate(source);

	normalized.discover[0].filters.push("[prefix[Local/]]");

	assert(source.discover[0].filters.length === 1);

	var invalid = warrant();
	invalid.binding.extra = true;

	throws(function () {
		warrants.validate(invalid);
	}, "Unsupported warrant binding field");

	invalid = warrant();
	invalid.binding.link = null;

	throws(function () {
		warrants.validate(invalid);
	});

	invalid = warrant();
	invalid.discover.push(invalid.discover[0]);

	throws(function () {
		warrants.validate(invalid);
	}, "Duplicate warrant discovery permission");

	invalid = warrant();
	invalid.generate.push({ name: "unsupported" });

	throws(function () {
		warrants.validate(invalid);
	}, "ordinary title prefix");

	invalid = warrant();
	invalid.edit.push({ name: "unsupported" });

	throws(function () {
		warrants.validate(invalid);
	}, "warrant editing target must be a record");

	invalid = warrant();
	invalid.discover[0].filters = [];

	throws(function () {
		warrants.validate(invalid);
	}, "non-empty array");

	var unbound = warrant();
	delete unbound.binding;

	assert(
		!Object.prototype.hasOwnProperty.call(
			warrants.validate(unbound),
			"binding"
		)
	);

	invalid = warrant();
	invalid.binding.link = 1;

	throws(function () {
		warrants.validate(invalid);
	}, "Invalid mission document");
}

function testStructuralNarrowing() {
	var source = warrant();

	var result = warrants.narrow(source, {
		discover: [
			{
				name: "sources",
				filters: ["[prefix[Public/]]"]
			}
		]
	});

	assert(result.discover.length === 1);
	assert(result.discover[0].name === "sources");

	assert(
		JSON.stringify(result.discover[0].filters) ===
		JSON.stringify([
			"[tag[Source]]",
			"[prefix[Public/]]"
		])
	);

	assert(
		JSON.stringify(result.binding) ===
		JSON.stringify(source.binding)
	);

	assert(source.discover.length === 2);
	assert(source.discover[0].filters.length === 1);

	assert(
		warrants.narrow(source, { discover: [] })
			.discover.length === 0
	);

	assert(
		JSON.stringify(warrants.narrow(source, {})) ===
		JSON.stringify(source)
	);

	throws(function () {
		warrants.narrow(source, {
			discover: [{ name: "unknown" }]
		});
	}, "Unknown warrant discovery permission");

	throws(function () {
		warrants.narrow(source, {
			binding: {
				project: "Another project",
				role: [],
				link: "1"
			}
		});
	}, "Unsupported warrant restriction field");

	throws(function () {
		warrants.narrow(source, {
			discover: [
				{ name: "sources" },
				{ name: "sources" }
			]
		});
	}, "Duplicate warrant discovery restriction");
}

function testCopyAndMovement() {
	var scope = open();

	try {
		var original = scope.incoming.get("warrant");
		var outgoing = scope.incoming.outgoing();

		scope.incoming.copy("warrant", outgoing, "copy");

		var copy = outgoing.get("copy");

		assert(copy !== original);

		var declaration = copy.declaration();
		declaration.discover[0].filters.push("local");

		assert(
			copy.declaration().discover[0].filters.length === 1
		);

		scope.incoming.destroy("warrant");

		throws(function () {
			original.declaration();
		}, "no longer available");

		assert(copy.declaration().form === "warrant");
		scope.assertResolved();

		var another = outgoing.outgoing();

		outgoing.move("copy", another, "moved");

		assert(another.get("moved") === copy);

		another.destroy("moved");

		throws(function () {
			copy.declaration();
		}, "no longer available");
	} finally {
		scope.close();
	}
}

function testScopedNarrowing() {
	var scope = open();

	try {
		var original = scope.incoming.get("warrant");
		var outgoing = scope.incoming.outgoing();

		var narrowed = original.narrow({
			discover: [
				{
					name: "sources",
					filters: ["[prefix[Public/]]"]
				}
			]
		}, outgoing, "restricted");

		assert(outgoing.get("restricted") === narrowed);
		assert(narrowed !== original);
		assert(narrowed.declaration().discover.length === 1);
		assert(original.declaration().discover.length === 2);

		throws(function () {
			scope.assertResolved();
		}, "unresolved");

		scope.incoming.destroy("warrant");
		scope.assertResolved();

		assert(narrowed.declaration().binding.link === "1");
	} finally {
		scope.close();
	}
}

function testRejectedCallsAreAtomic() {
	var scope = open();

	try {
		var form = scope.incoming.get("warrant");
		var outgoing = scope.incoming.outgoing();
		var before = JSON.stringify(scope.snapshot());

		throws(function () {
			form.narrow({
				discover: [{ name: "unknown" }]
			}, outgoing, "bad");
		}, "Unknown warrant discovery permission");

		assert(JSON.stringify(scope.snapshot()) === before);

		throws(function () {
			form.narrow({}, scope.operational, "restricted");
		}, "not writable");

		assert(JSON.stringify(scope.snapshot()) === before);

		throws(function () {
			form.narrow({}, scope.incoming, "restricted");
		}, "incoming registry");

		assert(JSON.stringify(scope.snapshot()) === before);

		form.narrow({}, outgoing, "existing");
		before = JSON.stringify(scope.snapshot());

		throws(function () {
			form.narrow({}, outgoing, "existing");
		}, "already exists");

		assert(JSON.stringify(scope.snapshot()) === before);
	} finally {
		scope.close();
	}
}

function testOperationalPlacement() {
	var committed = null;

	var scope = scopes.open({
		operational: {
			charter: {
				form: "charter",
				status: {}
			}
		},
		incoming: { warrant: warrant() },

		canWriteOperational: function () {
			return true;
		},

		commitOperational: function (before, after) {
			committed = schemas.copyJSON(after);
		}
	});

	try {
		scope.incoming.get("warrant").narrow(
			{ discover: [] },
			scope.operational,
			"restricted"
		);

		assert(committed.restricted.form === "warrant");
		assert(committed.restricted.discover.length === 0);
		assert(scope.incoming.keys().length === 1);
	} finally {
		scope.close();
	}
}

function testForeignDestination() {
	var first = open();
	var second = open();

	try {
		throws(function () {
			first.incoming.get("warrant").narrow(
				{},
				second.incoming.outgoing(),
				"foreign"
			);
		}, "must belong to this scope");
	} finally {
		first.close();
		second.close();
	}
}

function testClosedAccess() {
	var scope = open();
	var form = scope.incoming.get("warrant");
	var outgoing = scope.incoming.outgoing();

	scope.close();

	throws(function () {
		form.declaration();
	}, "closed");

	throws(function () {
		form.narrow({}, outgoing, "restricted");
	}, "closed");

	throws(function () {
		form.inspect();
	}, "closed");
}

function testBindingInspection() {
	var calls = 0;
	var current = true;

	var scope = scopes.open({
		operational: {
			charter: {
				form: "charter",
				status: {}
			}
		},
		incoming: {
			warrant: warrant()
		},

		readWarrantBinding: function (binding, snapshot) {
			calls++;

			assert(binding.project === "Research");
			assert(binding.link === "1");
			assert(snapshot.incoming.warrant.form === "warrant");

			/*
			Returned and received values must not expose the node.
			*/
			binding.project = "local mutation";

			return {
				active: current,
				reason: current ? null : "revoked"
			};
		}
	});

	try {
		var form = scope.incoming.get("warrant");

		assert(form.inspect().active === true);

		current = false;

		assert(form.inspect().active === false);
		assert(form.inspect().reason === "revoked");
		assert(calls === 3);

		assert(form.declaration().binding.project === "Research");
	} finally {
		scope.close();
	}
}

function testUnavailableBindingInspection() {
	var scope = open();

	try {
		var view = scope.incoming.get("warrant").inspect();

		assert(view.active === false);
		assert(view.reason.indexOf("unavailable") !== -1);
	} finally {
		scope.close();
	}
}

function testUnboundInspection() {
	var document = warrant();
	delete document.binding;

	var scope = scopes.open({
		operational: {
			charter: {
				form: "charter",
				status: {}
			}
		},
		incoming: {
			warrant: document
		}
	});

	try {
		var view = scope.incoming.get("warrant").inspect();

		assert(view.active === true);
		assert(view.reason === null);
	} finally {
		scope.close();
	}
}

function testContextualBindingNarrowing() {
	var calls = 0;

	var scope = scopes.open({
		operational: {
			charter: {
				form: "charter",
				status: {}
			}
		},
		incoming: {
			warrant: warrant()
		},

		authorizeWarrantBinding: function (source, target, snapshot) {
			calls++;

			assert(source.link === "1");
			assert(source.role.length === 0);
			assert(target.link === "1/1");
			assert(target.role.join("/") === "sources");
			assert(snapshot.incoming.warrant.binding.link === "1");

			source.project = "local mutation";
			target.project = "local mutation";
		}
	});

	try {
		var form = scope.incoming.get("warrant");
		var outgoing = scope.incoming.outgoing();

		var narrowed = form.narrow({
			binding: {
				project: "Research",
				role: ["sources"],
				link: "1/1"
			}
		}, outgoing, "child");

		assert(calls === 1);
		assert(narrowed.declaration().binding.project === "Research");
		assert(narrowed.declaration().binding.link === "1/1");
		assert(form.declaration().binding.link === "1");
	} finally {
		scope.close();
	}
}

function testBindingRejectionIsAtomic() {
	var scope = scopes.open({
		operational: {
			charter: {
				form: "charter",
				status: {}
			}
		},
		incoming: {
			warrant: warrant()
		},

		authorizeWarrantBinding: function () {
			throw new Error("Binding denied");
		}
	});

	try {
		var form = scope.incoming.get("warrant");
		var outgoing = scope.incoming.outgoing();
		var before = JSON.stringify(scope.snapshot());

		throws(function () {
			form.narrow({
				binding: {
					project: "Research",
					role: ["sources"],
					link: "1/1"
				},
				discover: []
			}, outgoing, "denied");
		}, "Binding denied");

		assert(JSON.stringify(scope.snapshot()) === before);

		throws(function () {
			form.narrow({
				binding: null
			}, outgoing, "unbound");
		});

		assert(JSON.stringify(scope.snapshot()) === before);
	} finally {
		scope.close();
	}
}

function testUnchangedBindingNeedsNoAuthorization() {
	var scope = open();

	try {
		var form = scope.incoming.get("warrant");
		var outgoing = scope.incoming.outgoing();

		/*
		No binding service is installed. The original binding
		is nevertheless preserved, including when explicit.
		*/
		var narrowed = form.narrow({
			binding: {
				project: "Research",
				role: [],
				link: "1"
			},
			discover: []
		}, outgoing, "same");

		assert(narrowed.declaration().binding.link === "1");
		assert(narrowed.declaration().discover.length === 0);
	} finally {
		scope.close();
	}
}

exports.run = function () {
	var cases = [
		["warrants: strict schema and isolated values", testSchema],
		["warrants: constructive discovery narrowing", testStructuralNarrowing],
		["warrants: copying and movement", testCopyAndMovement],
		["warrants: narrowing leaves the source unresolved", testScopedNarrowing],
		["warrants: rejected calls are atomic", testRejectedCallsAreAtomic],
		["warrants: operational placement is committed", testOperationalPlacement],
		["warrants: foreign destinations are rejected", testForeignDestination],
		["warrants: closed instruments provide no access", testClosedAccess],
		["warrants: binding inspection is live and isolated", testBindingInspection],
		["warrants: unavailable binding perspective denies authority", testUnavailableBindingInspection],
		["warrants: unbound authority needs no mission perspective", testUnboundInspection],
		["warrants: changed binding requires contextual authorization", testContextualBindingNarrowing],
		["warrants: rejected binding changes are atomic", testBindingRejectionIsAtomic],
		["warrants: unchanged binding needs no authorization", testUnchangedBindingNeedsNoAuthorization]
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