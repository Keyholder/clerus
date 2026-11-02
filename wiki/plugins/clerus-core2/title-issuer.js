/*\
title: $:/plugins/clerus/core2/title-issuer.js
type: application/javascript
module-type: library
\*/

"use strict";

var roles = require("$:/plugins/clerus/core2/roles.js");
var jobTitles = require(
	"$:/plugins/clerus/core2/job-titles.js"
);

function create(options) {
	if (
		!jobTitles.isJobTitle(options.title) ||
		typeof options.newId !== "function" ||
		!options.store ||
		typeof options.store.read !== "function"
	) {
		throw new Error(
			"Title issuer requires an owner, identifier source and store"
		);
	}

	var used = new Set();

	function issue(segment) {
		if (!roles.isSegment(segment)) {
			throw new Error("Invalid subordinate title segment");
		}

		var id = options.newId();

		if (
			typeof id !== "string" ||
			!/^[A-Za-z0-9_-]{16,128}$/.test(id)
		) {
			throw new Error("Invalid generated job identifier");
		}

		if (used.has(id)) {
			throw new Error("Job identifier source repeated an identity");
		}

		/*
		Consume the identifier even if a later check fails.
		An aborted operation must not make an identifier reusable.
		*/
		used.add(id);

		var title = options.title + "/" + segment + "-" + id;
		var current = options.store.read(title);

		if (current.kind !== "absent") {
			throw new Error("Generated job title is already occupied");
		}

		return title;
	}

	return Object.freeze({
		issue: issue
	});
}

exports.create = create;