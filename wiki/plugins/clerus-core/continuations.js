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
var proposals = require(
	"$:/plugins/clerus/core/proposal-schema.js"
);
var proposalWork = require(
	"$:/plugins/clerus/core/proposal-work.js"
);
var jobTitles = require(
	"$:/plugins/clerus/core/job-titles.js"
);
var custodySchema = require(
	"$:/plugins/clerus/core/custody-schema.js"
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

	var retention = options.store.continuationRetention || {
		delay: 0,
		now: Date.now
	};

	function currentTime() {
		var now = retention.now();

		if (!Number.isSafeInteger(now) || now < 0) {
			throw new Error("Invalid continuation retention clock");
		}

		return now;
	}

	function newDeadline() {
		var deadline = currentTime() + retention.delay;

		return custodySchema.retainUntil(deadline);
	}

	function accept(value) {
		if (typeof options.newId !== "function") {
			throw new Error(
				"Continuation acceptance requires an identity source"
			);
		}

		var initial = {
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
		};

		if (retention.delay > 0) {
			initial.retainUntil = newDeadline();

			if (initial.work !== null) {
				initial.work = custodySchema.withRetention(
					initial.work,
					initial.retainUntil
				);
			}
		}

		var record = continuationSchema.validate(
			initial,
			options.platform
		);

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

		custodySchema.assertWorkBinding(
			record.work,
			options.platform,
			title,
			record.retainUntil
		);

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
			options.platform,
			title
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
				options.platform,
				title
			);

			var empty = Object.keys(record.events).length === 0;

			var canDelete = empty && (
				record.retainUntil === undefined ||
				currentTime() >= record.retainUntil
			);

			if (canDelete) {
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

	function pending(title) {
		var record = read(title).record;

		if (record.work !== null) {
			return [];
		}

		return Object.keys(record.events).sort().filter(
			function (id) {
				return record.events[id].mode === "ready";
			}
		).map(function (id) {
			return schemas.copyJSON({
				id: id,
				event: record.events[id].event
			});
		});
	}

	function replace(loaded, record, custody, name) {
		var normalized = continuationSchema.validate(
			record,
			options.platform,
			loaded.fields.title
		);

		var after = schemas.copyJSON(loaded.fields);

		after.text = JSON.stringify(normalized);
		after["clerus-custody"] = custody;

		try {
			options.store.apply(stores.transition(
				loaded.fields.title,
				loaded.fields,
				after
			));
		} catch (cause) {
			var error = new Error(
				String(cause && cause.message || cause)
			);

			error.name = name;
			error.cause = cause;
			error.obligationTitle = loaded.fields.title;
			error.acceptanceUncertain = true;

			throw error;
		}
	}

	function acceptEvent(title, id, value) {
		var loaded = read(title);
		var record = loaded.record;

		if (record.work !== null) {
			throw new Error(
				"Continuation already has active materialization"
			);
		}

		if (
			!hasOwn(record.events, id) ||
			record.events[id].mode !== "ready"
		) {
			return "unavailable";
		}

		var event = record.events[id].event;

		var proposal = proposals.validate(value, {
			allowMessages: true,
			allowDeferred: true
		});

		if (
			proposal.owner.title !== event.recipient.title ||
			proposal.owner.executor !== event.recipient.executor
		) {
			throw new Error(
				"Event consequences belong to another recipient"
			);
		}

		var birth = proposal.owner.state === null;

		if (birth !== (event.establishing === true)) {
			throw new Error(
				"Proposal birth state does not match the event"
			);
		}

		var owner = options.store.read(proposal.owner.title);

		var matchesBaseline = birth
			? owner.kind === "absent"
			: owner.kind === "materialized" &&
				JSON.stringify(owner.fields) ===
					JSON.stringify(proposal.owner.state);

		if (!matchesBaseline) {
			throw new Error(
				"Event recipient baseline has changed"
			);
		}

		var nonempty = (
			proposal.plan.effects.length !== 0 ||
			proposal.plan.messages.length !== 0 ||
			proposal.plan.deferred.length !== 0
		);

		if (nonempty && typeof options.newId !== "function") {
			throw new Error(
				"Event acceptance requires an identity source"
			);
		}

		var work = proposalWork.convert(
			proposal,
			nonempty ? options.newId() : undefined,
			options.platform,
			birth
		);

		if (
			work !== null &&
			record.retainUntil !== undefined
		) {
			work = custodySchema.withRetention(
				work,
				record.retainUntil
			);
		}

		if (work !== null) {
			compatibility.check({
				store: options.store,
				title: title,
				work: work
			});

			materializer.check({
				store: options.store,
				platform: options.platform,
				work: work
			});
		}

		delete record.events[id];
		record.work = work;

		/*
			The event fingerprint remains in evidence.

			The authoritative replacement happens in one write:
			before it the event is pending; after it the accepted
			consequences are authoritative.
		*/
		replace(
			loaded,
			record,
			options.platform,
			"ContinuationEventAcceptanceError"
		);

		return "accepted";
	}

		function failEvent(title, id, recipient, cause) {
		var loaded = read(title);
		var record = loaded.record;

		if (record.work !== null) {
			throw new Error(
				"Cannot fail an event during materialization"
			);
		}

		if (
			!hasOwn(record.events, id) ||
			record.events[id].mode !== "ready"
		) {
			return "unavailable";
		}

		var event = record.events[id].event;

		if (
			!recipient ||
			recipient.title !== event.recipient.title ||
			recipient.executor !== event.recipient.executor
		) {
			throw new Error(
				"Event failure belongs to another recipient"
			);
		}

		record.events[id].mode = "paused";

		record.diagnostics.push({
			event: id,
			phase: "reaction",
			error: describe(cause)
		});

		var hasReady = Object.keys(record.events).some(
			function (key) {
				return record.events[key].mode === "ready";
			}
		);

		replace(
			loaded,
			record,
			hasReady ? options.platform : "user",
			"ContinuationEventFailureError"
		);

		return "paused";
	}

	function completeEphemeral(title, id, recipient) {
		var loaded = read(title);
		var record = loaded.record;

		if (record.work !== null) {
			throw new Error(
				"Cannot acknowledge during materialization"
			);
		}

		if (
			!hasOwn(record.events, id) ||
			record.events[id].mode !== "ready"
		) {
			return "unavailable";
		}

		var event = record.events[id].event;
		var space = jobTitles.classify(
			event.recipient.title
		);

		if (
			event.kind !== "delivery" ||
			!space ||
			space.persistent ||
			space.platform !== options.platform ||
			!recipient ||
			recipient.title !== event.recipient.title ||
			recipient.executor !== event.recipient.executor
		) {
			throw new Error(
				"Ephemeral acknowledgement belongs to another recipient"
			);
		}

		delete record.events[id];

		/*
			Only completion is recorded.
			No persistent work is invented for effects already
			performed by the ephemeral reaction.
		*/
		replace(
			loaded,
			record,
			options.platform,
			"ContinuationEphemeralAcknowledgementError"
		);

		return "completed";
	}

	return Object.freeze({
		accept: accept,
		read: read,
		resume: resume,
		recover: recover,
		pending: pending,
		acceptEvent: acceptEvent,
		failEvent: failEvent,
		completeEphemeral: completeEphemeral
	});
}

exports.create = create;