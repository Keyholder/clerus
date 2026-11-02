/*\
title: $:/plugins/clerus/core/obligations.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var proposals = require(
	"$:/plugins/clerus/core/proposal-schema.js"
);
var stores = require("$:/plugins/clerus/core/store.js");
var materializer = require(
	"$:/plugins/clerus/core/materializer.js"
);
var barriers = require(
	"$:/plugins/clerus/core/materialization-barrier.js"
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
	var walPrefix = "$:/clerus/wal/" + options.platform + "/";
	var prefix = walPrefix + "plan-";
	var recovering = false;

	function accept(value) {
		var proposal = proposals.validate(value);

		if (proposal.owner.state === null) {
			throw new Error(
				"Birth proposal requires an establishing flow message"
			);
		}

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

		var blockers = barriers.collect({
			store: options.store
		}).forJob(proposal.owner.title);

		if (blockers.length > 0) {
			throw new Error(
				"Proposal owner has unfinished materialization: " +
				blockers.join(", ")
			);
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

		try {
			options.store.apply(stores.transition(title, null, {
				title: title,
				type: "application/json",
				"clerus-custody": options.platform,
				"clerus-wal-kind": "plan",
				text: JSON.stringify(record)
			}));
		} catch (cause) {
			var error = new Error(
				String(cause && cause.message || cause)
			);

			error.name = "ObligationRegistrationError";
			error.cause = cause;
			error.obligationTitle = title;
			error.acceptanceUncertain = true;

			throw error;
		}

		return title;
	}

	function read(title) {
		if (
			typeof title !== "string" ||
			title.indexOf(walPrefix) !== 0
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
			title.indexOf(walPrefix) !== 0
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

	function recover() {
		if (recovering) {
			throw new Error("Obligation recovery is already running");
		}

		recovering = true;

		try {
			var titles = options.store.snapshot().materialized.filter(
				function (fields) {
					return fields.title.indexOf(walPrefix) === 0;
				}
			).map(function (fields) {
				return fields.title;
			}).sort();

			var entries = [];

			titles.forEach(function (title) {
				var current;

				try {
					current = options.store.read(title);
				} catch (error) {
					entries.push({
						title: title,
						status: "failed",
						error: String(error && error.message || error)
					});

					return;
				}

				if (current.kind !== "materialized") {
					entries.push({
						title: title,
						status: "absent"
					});

					return;
				}

				var fields = current.fields;
				var kind = fields["clerus-wal-kind"];

				if (kind === "incident") {
					entries.push({
						title: title,
						status: "historical"
					});

					return;
				}

				if (kind === "flow" || kind === "deferred") {
					entries.push({
						title: title,
						status: "delegated",
						kind: kind
					});

					return;
				}

				if (fields["clerus-custody"] !== options.platform) {
					entries.push({
						title: title,
						status: "paused"
					});

					return;
				}

				if (kind !== "plan") {
					var unsupported = new Error(
						"Unsupported recoverable WAL kind"
					);

					var diagnostic = {
						title: title,
						status: "unsupported",
						error: unsupported.message
					};

					try {
						pause(title, unsupported);
					} catch (error) {
						diagnostic.pauseError = String(
							error && error.message || error
						);
					}

					entries.push(diagnostic);
					return;
				}

				try {
					entries.push({
						title: title,
						status: "completed",
						results: resume(title)
					});
				} catch (error) {
					entries.push({
						title: title,
						status: "failed",
						error: String(error && error.message || error),
						pauseError: error && error.pauseError
							? String(error.pauseError)
							: null
					});
				}
			});

			return {
				entries: entries
			};
		} finally {
			recovering = false;
		}
	}

	return Object.freeze({
		accept: accept,
		read: read,
		resume: resume,
		recover: recover
	});
}

exports.create = create;