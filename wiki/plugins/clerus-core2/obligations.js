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
var materializer = require(
	"$:/plugins/clerus/core2/materializer.js"
);

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

	function read(title) {
		if (
			typeof title !== "string" ||
			title.indexOf(prefix) !== 0
		) {
			throw new Error("Cannot read a foreign plan obligation");
		}

		var journal = options.store.read(title);

		if (
			journal.kind !== "materialized" ||
			journal.fields.type !== "application/json" ||
			journal.fields["clerus-wal-kind"] !== "plan" ||
			journal.fields["clerus-custody"] !== options.platform
		) {
			throw new Error("Plan obligation is not locally owned");
		}

		var record = materializer.validate(
			JSON.parse(journal.fields.text),
			options.platform
		);

		return {
			fields: journal.fields,
			record: record
		};
	}

	function pause(title, error) {
		if (
			typeof title !== "string" ||
			title.indexOf(prefix) !== 0
		) {
			return;
		}

		var current = options.store.read(title);

		if (
			current.kind !== "materialized" ||
			current.fields["clerus-custody"] !== options.platform
		) {
			return;
		}

		var after = schemas.copyJSON(current.fields);

		after["clerus-custody"] = "user";
		after["clerus-wal-error"] = JSON.stringify({
			name: String(error && error.name || "Error"),
			message: String(error && error.message || error),
			stack: error && error.stack ? String(error.stack) : null
		});

		/*
			Preserve the body, including a malformed one.
		*/
		options.store.apply(stores.transition(
			title,
			current.fields,
			after
		));
	}

	function resume(title) {
		try {
			var loaded = read(title);

			var results = materializer.execute({
				store: options.store,
				platform: options.platform,
				record: loaded.record
			});

			options.store.apply(stores.transition(
				title,
				loaded.fields,
				null
			));

			return results;
		} catch (error) {
			try {
				pause(title, error);
			} catch (pauseError) {
				/*
					Do not hide the original failure if writing
					the pause diagnostic also fails.
				*/
				if (error && typeof error === "object") {
					error.pauseError = String(
						pauseError && pauseError.message || pauseError
					);
				}
			}

			throw error;
		}
	}

	return Object.freeze({
		accept: accept,
		read: read,
		resume: resume
	});
}

exports.create = create;