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
	var ownerSpace = jobTitles.classify(options.title);

	function issue(segment, temporary) {
		if (!roles.isSegment(segment)) {
			throw new Error("Invalid subordinate title segment");
		}

		if (
			temporary !== undefined &&
			typeof temporary !== "boolean"
		) {
			throw new Error("Temporary title choice must be boolean");
		}

		var temp = temporary === undefined
			? !ownerSpace.persistent
			: temporary;

		if (!ownerSpace.persistent && !temp) {
			throw new Error(
				"An ephemeral job cannot issue a persistent subordinate title"
			);
		}

		var base = options.title;

		if (ownerSpace.persistent && temp) {
			if (
				options.platform !== "browser" &&
				options.platform !== "node"
			) {
				throw new Error(
					"Temporary title issuance requires a platform"
				);
			}

			base = "$:/temp/clerus/jobs/" + options.platform + "/" +
				options.title.slice(ownerSpace.prefix.length);
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

		used.add(id);

		var title = base + "/" + segment + "-" + id;

		if (options.store.read(title).kind !== "absent") {
			throw new Error("Generated job title is already occupied");
		}

		return title;
	}

	return Object.freeze({
		issue: issue
	});
}

exports.create = create;