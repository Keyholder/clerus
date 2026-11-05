/*\
title: $:/plugins/clerus/core/continuations.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var stores = require("$:/plugins/clerus/core/store.js");
var envelopes = require("$:/plugins/clerus/core/wal-envelope.js");
var continuationSchema = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);
var materializer = require(
	"$:/plugins/clerus/core/work-materializer.js"
);
var compatibility = require(
	"$:/plugins/clerus/core/work-compatibility.js"
);

function describe(error) {
	return {
		name: String(error && error.name || "Error"),
		message: String(error && error.message || error)
	};
}

function create(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.store.read !== "function" ||
		typeof options.store.snapshot !== "function" ||
		typeof options.store.check !== "function" ||
		typeof options.store.apply !== "function"
	) {
		throw new Error("Continuations require a state store");
	}

	var prefix = "$:/clerus/wal/" + options.platform + "/";
	var recovering = false;

	function assertLocalTitle(title) {
		if (
			typeof title !== "string" ||
			title.indexOf(prefix) !== 0 ||
			title.length === prefix.length
		) {
			throw new Error("Cannot service a foreign continuation");
		}
	}

	function read(title) {
		assertLocalTitle(title);

		var current = options.store.read(title);

		if (
			current.kind !== "materialized" ||
			current.fields["clerus-custody"] !== options.platform
		) {
			throw new Error("Continuation is not locally owned");
		}

		var record = continuationSchema.validate(
			envelopes.requireRecord(
				current.fields,
				options.platform,
				"continuation"
			),
			options.platform
		);

		return {
			fields: current.fields,
			record: record
		};
	}

	function pause(title, error) {
		assertLocalTitle(title);

		var current = options.store.read(title);

		if (
			current.kind !== "materialized" ||
			current.fields["clerus-custody"] !== options.platform
		) {
			return;
		}

		var after = schemas.copyJSON(current.fields);

		after["clerus-custody"] = "user";
		after["clerus-wal-error"] = JSON.stringify(
			describe(error)
		);

		/*
			Preserve the authoritative body, including malformed JSON.
		*/
		options.store.apply(stores.transition(
			title,
			current.fields,
			after
		));
	}

	function checkConflicts(title, work) {
		compatibility.check({
			store: options.store,
			title: title,
			work: work
		});
	}

	function resume(title) {
		try {
			var loaded = read(title);
			var work = loaded.record.work;
			var results = [];

			if (work !== null) {
				checkConflicts(title, work);

				results = materializer.execute({
					store: options.store,
					platform: options.platform,
					work: work
				});
			}

			/*
				This supported subset has no events or receipts.

				Deleting the journal is the authoritative completion
				of its last material work.
			*/
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
				if (error && typeof error === "object") {
					error.pauseError = String(
						pauseError && pauseError.message ||
						pauseError
					);
				}
			}

			throw error;
		}
	}

	function recover(selection) {
		if (recovering) {
			throw new Error(
				"Continuation recovery is already running"
			);
		}

		var titles;

		if (selection === undefined) {
			titles = options.store.snapshot().materialized.filter(
				function (fields) {
					return (
						fields.title.indexOf(prefix) === 0 &&
						fields["clerus-wal-kind"] === "continuation"
					);
				}
			).map(function (fields) {
				return fields.title;
			});
		} else {
			if (
				!schemas.isRecord(selection) ||
				Object.keys(selection).some(function (key) {
					return key !== "titles";
				}) ||
				!Array.isArray(selection.titles)
			) {
				throw new Error(
					"Continuation recovery requires a titles array"
				);
			}

			titles = selection.titles.slice();
		}

		titles.forEach(assertLocalTitle);

		if (new Set(titles).size !== titles.length) {
			throw new Error(
				"Continuation recovery titles must be unique"
			);
		}

		titles.sort();
		recovering = true;

		try {
			var entries = [];

			titles.forEach(function (title) {
				try {
					var current = options.store.read(title);

					if (current.kind !== "materialized") {
						entries.push({
							title: title,
							status: "absent"
						});
						return;
					}

					if (
						current.fields["clerus-custody"] !==
							options.platform
					) {
						entries.push({
							title: title,
							status: "paused"
						});
						return;
					}

					entries.push({
						title: title,
						status: "completed",
						results: resume(title)
					});
				} catch (error) {
					var entry = {
						title: title,
						status: "failed",
						error: String(
							error && error.message || error
						)
					};

					if (error && error.pauseError) {
						entry.pauseError = error.pauseError;
					}

					entries.push(entry);
				}
			});

			return { entries: entries };
		} finally {
			recovering = false;
		}
	}

	return Object.freeze({
		read: read,
		resume: resume,
		recover: recover
	});
}

exports.create = create;