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
var eventSchema = require(
	"$:/plugins/clerus/core/event-schema.js"
);

var hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);

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

	if (
		options.newId !== undefined &&
		typeof options.newId !== "function"
	) {
		throw new Error("Continuation newId must be a function");
	}

	var prefix = "$:/clerus/wal/" + options.platform + "/";
	var recovering = false;
	var used = new Set();

	function accept(value) {
		if (typeof options.newId !== "function") {
			throw new Error(
				"Continuation acceptance requires an identity source"
			);
		}

		var record = continuationSchema.validate({
			version: 2,
			kind: "continuation",
			platform: options.platform,
			work: value,
			events: {},
			evidence: {
				identities: {},
				receipts: {}
			},
			diagnostics: []
		}, options.platform);

		if (record.work === null) {
			throw new Error(
				"Cannot accept a continuation without work"
			);
		}

		compatibility.check({
			store: options.store,
			work: record.work
		});

		materializer.check({
			store: options.store,
			platform: options.platform,
			work: record.work
		});

		var id = options.newId();

		if (
			typeof id !== "string" ||
			!/^[A-Za-z0-9_-]{16,128}$/.test(id) ||
			used.has(id)
		) {
			throw new Error(
				"Invalid or reused continuation identifier"
			);
		}

		used.add(id);

		var title = prefix + "continuation-" + id;

		if (options.store.read(title).kind !== "absent") {
			throw new Error(
				"Continuation title is occupied"
			);
		}

		var fields = {
			title: title,
			type: "application/json",
			"clerus-custody": options.platform,
			"clerus-wal-kind": "continuation",
			text: JSON.stringify(record)
		};

		try {
			options.store.apply(stores.transition(
				title,
				null,
				fields
			));
		} catch (cause) {
			var error = new Error(
				String(cause && cause.message || cause)
			);

			error.name = "ContinuationRegistrationError";
			error.cause = cause;
			error.obligationTitle = title;
			error.acceptanceUncertain = true;

			throw error;
		}

		return title;
	}

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
			var record = loaded.record;
			var work = record.work;
			var results = [];

			if (work !== null) {
				checkConflicts(title, work);

				results = materializer.execute({
					store: options.store,
					platform: options.platform,
					work: work
				});

				work.emits.forEach(function (effect) {
					if (
						hasOwn(
							record.evidence.identities,
							effect.id
						)
					) {
						return;
					}

					Object.defineProperty(
						record.evidence.identities,
						effect.id,
						{
							value: eventSchema.fingerprint(
								effect.event
							),
							enumerable: true,
							writable: true,
							configurable: true
						}
					);

					Object.defineProperty(
						record.events,
						effect.id,
						{
							value: {
								mode: "ready",
								event: effect.event
							},
							enumerable: true,
							writable: true,
							configurable: true
						}
					);
				});

				record.work = null;
			}

			record = continuationSchema.validate(
				record,
				options.platform
			);

			if (Object.keys(record.events).length === 0) {
				options.store.apply(stores.transition(
					title,
					loaded.fields,
					null
				));
			} else {
				var after = schemas.copyJSON(loaded.fields);

				after.text = JSON.stringify(record);

				options.store.apply(stores.transition(
					title,
					loaded.fields,
					after
				));
			}

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

					var results = resume(title);
					var remaining = options.store.read(title);

					entries.push({
						title: title,
						status: remaining.kind === "absent"
							? "completed"
							: "pending",
						results: results
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
		accept: accept,
		read: read,
		resume: resume,
		recover: recover
	});
}

exports.create = create;