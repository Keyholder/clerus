/*\
title: $:/plugins/clerus/core2/obligations.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var proposals = require(
	"$:/plugins/clerus/core2/proposal-schema.js"
);
var stores = require("$:/plugins/clerus/core2/store.js");

function create(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.store.read !== "function" ||
		typeof options.store.check !== "function" ||
		typeof options.store.apply !== "function" ||
		typeof options.store.snapshot !== "function" ||
		typeof options.newId !== "function"
	) {
		throw new Error("Obligations require a store and identity source");
	}

	var used = new Set();
	var prefix = "$:/clerus/wal/" + options.platform + "/plan-";

	function accept(value) {
		var proposal = proposals.validate(value);
		var owner = options.store.read(proposal.owner.title);

		if (
			owner.kind !== "materialized" ||
			JSON.stringify(owner.fields) !==
				JSON.stringify(proposal.owner.state)
		) {
			throw new Error("Proposal owner state has changed");
		}

		if (proposal.plan.effects.length === 0) {
			return null;
		}

		if (
			proposal.owner.state["clerus-custody"] !==
			options.platform
		) {
			throw new Error("Proposal owner is not locally authorized");
		}

		var shadowTitles = new Set(
			options.store.snapshot().shadows.map(function (fields) {
				return fields.title;
			})
		);

		proposal.plan.effects.forEach(function (effect) {
			if (shadowTitles.has(effect.title)) {
				throw new Error(
					"Proposal target is shadow-backed"
				);
			}

			if (
				effect.before !== null &&
				effect.before["clerus-custody"] !== options.platform
			) {
				throw new Error(
					"Proposal target was not locally authorized"
				);
			}

			if (
				effect.before === null &&
				effect.after["clerus-custody"] !== options.platform
			) {
				throw new Error(
					"Created target must belong to the creating platform"
				);
			}

			options.store.check(effect);
		});

		var id = options.newId();

		if (
			typeof id !== "string" ||
			!/^[A-Za-z0-9_-]{16,128}$/.test(id)
		) {
			throw new Error("Invalid obligation identifier");
		}

		if (used.has(id)) {
			throw new Error("Obligation identifier was reused");
		}

		used.add(id);

		var title = prefix + id;

		if (options.store.read(title).kind !== "absent") {
			throw new Error("Obligation title is occupied");
		}

		var record = {
			version: 1,
			kind: "plan",
			platform: options.platform,
			proposal: proposal
		};

		options.store.apply(stores.transition(title, null, {
			title: title,
			type: "application/json",
			"clerus-custody": options.platform,
			"clerus-wal-kind": "plan",
			text: JSON.stringify(record)
		}));

		return title;
	}

	return Object.freeze({
		accept: accept
	});
}

exports.create = create;