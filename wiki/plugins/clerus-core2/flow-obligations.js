/*\
title: $:/plugins/clerus/core2/flow-obligations.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var proposals = require("$:/plugins/clerus/core2/proposal-schema.js");
var flows = require("$:/plugins/clerus/core2/flow-schema.js");
var messages = require("$:/plugins/clerus/core2/message-effect.js");
var materializer = require("$:/plugins/clerus/core2/materializer.js");
var barriers = require(
	"$:/plugins/clerus/core2/materialization-barrier.js"
);
var stores = require("$:/plugins/clerus/core2/store.js");
var jobTitles = require(
	"$:/plugins/clerus/core2/job-titles.js"
);

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
);

function stateRecord(record) {
	return {
		version: 1,
		kind: "plan",
		platform: record.platform,
		proposal: {
			version: 1,
			owner: record.active.owner,
			plan: {
				version: 1,
				effects: record.active.plan.effects
			}
		}
	};
}

function create(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.store.read !== "function" ||
		typeof options.store.snapshot !== "function" ||
		typeof options.store.check !== "function" ||
		typeof options.store.apply !== "function" ||
		typeof options.newId !== "function"
	) {
		throw new Error("Flow obligations require a store and identity source");
	}

	var walPrefix = "$:/clerus/wal/" + options.platform + "/";
	var used = new Set();

	function read(title) {
		if (
			typeof title !== "string" ||
			title.indexOf(walPrefix) !== 0
		) {
			throw new Error("Cannot read a foreign flow");
		}

		var stored = options.store.read(title);

		if (
			stored.kind !== "materialized" ||
			stored.fields.type !== "application/json" ||
			stored.fields["clerus-wal-kind"] !== "flow" ||
			stored.fields["clerus-custody"] !== options.platform
		) {
			throw new Error("Flow is not locally owned");
		}

		return {
			fields: stored.fields,
			record: flows.validate(
				JSON.parse(stored.fields.text),
				options.platform
			)
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
			message: String(error && error.message || error)
		});

		options.store.apply(stores.transition(
			title,
			current.fields,
			after
		));
	}

	function checkEstablishmentReservations(proposal) {
		var requested = new Set();

		proposal.plan.messages.forEach(function (message) {
			if (message.establishing !== true) {
				return;
			}

			var target = message.recipient.title;

			if (requested.has(target)) {
				throw new Error(
					"Proposal contains repeated establishment target"
				);
			}

			requested.add(target);

			if (options.store.read(target).kind !== "absent") {
				throw new Error("Establishment target is occupied");
			}
		});

		if (requested.size === 0) {
			return;
		}

		options.store.snapshot().materialized.forEach(function (fields) {
			if (
				fields.title.indexOf(walPrefix) !== 0 ||
				fields["clerus-wal-kind"] !== "flow"
			) {
				return;
			}

			/*
				Custody does not cancel a previously accepted reservation.
				An unreadable flow prevents proving that an address is free.
			*/
			var record = flows.validate(
				JSON.parse(fields.text),
				options.platform
			);

			if (
				record.active !== null &&
				record.active.owner.state === null &&
				requested.has(record.active.owner.title)
			) {
				throw new Error(
					"Target has an accepted unfinished birth"
				);
			}

			var messages = record.pending.slice();

			if (record.active !== null) {
				messages = messages.concat(
					record.active.plan.messages
				);
			}

			messages.forEach(function (message) {
				if (
					message.establishing === true &&
					requested.has(message.recipient.title)
				) {
					throw new Error(
						"Target already has a pending establishment"
					);
				}
			});
		});
	}

	function register(value) {
		var proposal = proposals.validate(value, {
			allowMessages: true
		});

		if (proposal.owner.state === null) {
			throw new Error(
				"Root flow requires an existing owner"
			);
		}

		if (
			proposal.plan.effects.length === 0 &&
			proposal.plan.messages.length === 0
		) {
			throw new Error("Cannot register an empty flow");
		}

		var owner = options.store.read(proposal.owner.title);

		if (
			owner.kind !== "materialized" ||
			JSON.stringify(owner.fields) !==
				JSON.stringify(proposal.owner.state)
		) {
			throw new Error("Flow owner state has changed");
		}

		if (
			barriers.collect({
				store: options.store
			}).forJob(proposal.owner.title).length > 0
		) {
			throw new Error("Flow owner has unfinished materialization");
		}

		checkEstablishmentReservations(proposal);

		var record = flows.validate({
			version: 1,
			kind: "flow",
			platform: options.platform,
			active: proposal,
			pending: [],
			seen: {},
			errors: []
		}, options.platform);

		materializer.check({
			store: options.store,
			platform: options.platform,
			record: stateRecord(record),
			allowEmpty: true
		});

		var id = options.newId();

		if (
			typeof id !== "string" ||
			!/^[A-Za-z0-9_-]{16,128}$/.test(id) ||
			used.has(id)
		) {
			throw new Error("Invalid or reused flow identifier");
		}

		used.add(id);

		var title = walPrefix + "flow-" + id;

		if (options.store.read(title).kind !== "absent") {
			throw new Error("Flow title is occupied");
		}

		try {
			options.store.apply(stores.transition(title, null, {
				title: title,
				type: "application/json",
				"clerus-custody": options.platform,
				"clerus-wal-kind": "flow",
				text: JSON.stringify(record)
			}));
		} catch (cause) {
			var error = new Error(
				String(cause && cause.message || cause)
			);

			error.name = "FlowRegistrationError";
			error.cause = cause;
			error.obligationTitle = title;
			error.acceptanceUncertain = true;

			throw error;
		}

		return title;
	}

	function resume(title) {
		try {
			var loaded = read(title);
			var record = loaded.record;

			if (record.active !== null) {
				materializer.execute({
					store: options.store,
					platform: options.platform,
					record: stateRecord(record),
					allowEmpty: true
				});

				record.active.plan.messages.forEach(function (message) {
					if (hasOwn(record.seen, message.id)) {
						return;
					}

					Object.defineProperty(record.seen, message.id, {
						value: messages.fingerprint(message),
						enumerable: true,
						writable: true,
						configurable: true
					});

					record.pending.push(message);
				});

				record.active = null;
			}

			if (
				record.pending.length === 0 &&
				record.errors.length === 0
			) {
				options.store.apply(stores.transition(
					title,
					loaded.fields,
					null
				));

				return [];
			}

			var after = schemas.copyJSON(loaded.fields);
			after["clerus-custody"] = record.pending.length === 0
				? "user"
				: options.platform;
			after.text = JSON.stringify(record);

			options.store.apply(stores.transition(
				title,
				loaded.fields,
				after
			));

			return schemas.copyJSON(record.pending);
		} catch (error) {
			try {
				pause(title, error);
			} catch (pauseError) {
				if (error && typeof error === "object") {
					error.pauseError = String(
						pauseError && pauseError.message || pauseError
					);
				}
			}

			throw error;
		}
	}

	function pending(title) {
		var record = read(title).record;

		return record.active === null
			? schemas.copyJSON(record.pending)
			: [];
	}

	function accept(title, messageId, value) {
		var loaded = read(title);
		var record = loaded.record;

		if (record.active !== null) {
			throw new Error("Flow already has active materialization");
		}

		var index = record.pending.findIndex(function (message) {
			return message.id === messageId;
		});

		if (index === -1) {
			if (hasOwn(record.seen, messageId)) {
				return "already-completed";
			}

			throw new Error("Unknown pending flow message");
		}

		var incoming = record.pending[index];

		var proposal = proposals.validate(value, {
			allowMessages: true
		});

		if (
			proposal.owner.title !== incoming.recipient.title ||
			proposal.owner.executor !== incoming.recipient.executor
		) {
			throw new Error(
				"Flow message was accepted by another recipient"
			);
		}

		var birth = proposal.owner.state === null;

		if (birth !== (incoming.establishing === true)) {
			throw new Error(
				"Proposal birth state does not match the incoming message"
			);
		}

		var owner = options.store.read(proposal.owner.title);

		var matchesBaseline = birth
			? owner.kind === "absent"
			: owner.kind === "materialized" &&
				JSON.stringify(owner.fields) ===
					JSON.stringify(proposal.owner.state);

		if (!matchesBaseline) {
			throw new Error("Recipient proposal owner state has changed");
		}

		var blockers = barriers.collect({
			store: options.store
		}).forJob(proposal.owner.title);

		if (blockers.length > 0) {
			throw new Error(
				"Recipient has unfinished materialization"
			);
		}

		checkEstablishmentReservations(proposal);

		/*
			Build and validate the entire replacement before writing.
			The pending message remains authoritative until this write.
		*/
		record.pending.splice(index, 1);
		record.active = proposal;

		record = flows.validate(record, options.platform);

		materializer.check({
			store: options.store,
			platform: options.platform,
			record: stateRecord(record),
			allowEmpty: true
		});

		var after = schemas.copyJSON(loaded.fields);
		after.text = JSON.stringify(record);

		try {
			options.store.apply(stores.transition(
				title,
				loaded.fields,
				after
			));
		} catch (cause) {
			var error = new Error(
				String(cause && cause.message || cause)
			);

			error.name = "FlowAcceptanceError";
			error.cause = cause;
			error.obligationTitle = title;
			error.acceptanceUncertain = true;

			throw error;
		}

		return "accepted";
	}

	function fail(title, messageId, recipient, cause) {
		var loaded = read(title);
		var record = loaded.record;

		if (record.active !== null) {
			throw new Error(
				"Cannot fail a message during active materialization"
			);
		}

		var index = record.pending.findIndex(function (message) {
			return message.id === messageId;
		});

		if (index === -1) {
			if (hasOwn(record.seen, messageId)) {
				return {
					status: "already-completed",
					pending: schemas.copyJSON(record.pending)
				};
			}

			throw new Error("Unknown pending flow message");
		}

		var message = record.pending[index];

		if (
			!recipient ||
			recipient.title !== message.recipient.title ||
			recipient.executor !== message.recipient.executor
		) {
			throw new Error(
				"Message failure belongs to another recipient"
			);
		}

		record.pending.splice(index, 1);

		record.errors.push({
			message: message,
			error: {
				name: String(cause && cause.name || "Error"),
				message: String(cause && cause.message || cause),
				stack: cause && cause.stack
					? String(cause.stack)
					: null
			}
		});

		record = flows.validate(record, options.platform);

		var after = schemas.copyJSON(loaded.fields);
		after.text = JSON.stringify(record);

		try {
			options.store.apply(stores.transition(
				title,
				loaded.fields,
				after
			));
		} catch (cause) {
			var error = new Error(
				String(cause && cause.message || cause)
			);

			error.name = "FlowFailureRegistrationError";
			error.cause = cause;
			error.obligationTitle = title;
			error.acceptanceUncertain = true;

			throw error;
		}

		return {
			status: "failed",
			pending: resume(title)
		};
	}

	function recover() {
		var walTitles = options.store.snapshot().materialized.filter(
			function (fields) {
				return fields.title.indexOf(walPrefix) === 0 &&
					fields["clerus-wal-kind"] === "flow";
			}
		).map(function (fields) {
			return fields.title;
		}).sort();

		var entries = [];

		walTitles.forEach(function (title) {
			var current = options.store.read(title);

			if (current.kind !== "materialized") {
				entries.push({
					title: title,
					status: "absent"
				});

				return;
			}

			if (
				current.fields["clerus-custody"] !== options.platform
			) {
				entries.push({
					title: title,
					status: "paused"
				});

				return;
			}

			try {
				var pendingMessages = resume(title);
				var remaining = options.store.read(title);

				entries.push({
					title: title,

					status: remaining.kind === "absent"
						? "completed"
						: remaining.fields["clerus-custody"] === "user"
							? "paused"
							: "pending",

					pending: pendingMessages
				});
			} catch (error) {
				entries.push({
					title: title,
					status: "failed",
					error: String(error && error.message || error)
				});
			}
		});

		return {
			entries: entries
		};
	}

	function completeEphemeral(title, messageId, recipient) {
		var loaded = read(title);
		var record = loaded.record;

		if (record.active !== null) {
			throw new Error(
				"Cannot acknowledge delivery during active materialization"
			);
		}

		var index = record.pending.findIndex(function (message) {
			return message.id === messageId;
		});

		if (index === -1) {
			if (hasOwn(record.seen, messageId)) {
				return {
					status: "already-completed",
					pending: schemas.copyJSON(record.pending)
				};
			}

			throw new Error("Unknown pending flow message");
		}

		var message = record.pending[index];
		var space = jobTitles.classify(message.recipient.title);

		if (
			!space ||
			space.persistent ||
			space.platform !== options.platform ||
			!recipient ||
			recipient.title !== message.recipient.title ||
			recipient.executor !== message.recipient.executor
		) {
			throw new Error(
				"Ephemeral acknowledgement belongs to another recipient"
			);
		}

		/*
			Only completion is recorded. No persistent plan is invented
			for effects that were already performed ephemerally.
		*/
		record.pending.splice(index, 1);
		record = flows.validate(record, options.platform);

		var after = schemas.copyJSON(loaded.fields);
		after.text = JSON.stringify(record);

		try {
			options.store.apply(stores.transition(
				title,
				loaded.fields,
				after
			));
		} catch (cause) {
			var error = new Error(
				String(cause && cause.message || cause)
			);

			error.name = "EphemeralAcknowledgementError";
			error.cause = cause;
			error.obligationTitle = title;
			error.acceptanceUncertain = true;

			throw error;
		}

		return {
			status: "completed",
			pending: resume(title)
		};
	}

	return Object.freeze({
		register: register,
		read: read,
		resume: resume,
		pending: pending,
		accept: accept,
		fail: fail,
		recover: recover,
		completeEphemeral: completeEphemeral,
	});
}

exports.create = create;