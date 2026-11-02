/*\
title: $:/plugins/clerus/core2/deferred-obligations.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var effects = require("$:/plugins/clerus/core2/deferred-effect.js");
var flowSchema = require("$:/plugins/clerus/core2/flow-schema.js");
var stores = require("$:/plugins/clerus/core2/store.js");

var proposals = require(
	"$:/plugins/clerus/core2/proposal-schema.js"
);

var materializer = require(
	"$:/plugins/clerus/core2/materializer.js"
);

function validate(value, platform) {
	schemas.assertPlatform(platform);

	var record = schemas.copyJSON(value);

	if (
		!schemas.isRecord(record) ||
		Object.keys(record).some(function (key) {
			return [
				"version", "kind", "platform", "effect"
			].indexOf(key) === -1;
		}) ||
		record.version !== 1 ||
		record.kind !== "deferred" ||
		record.platform !== platform
	) {
		throw new Error("Invalid deferred obligation");
	}

	var effect = effects.validate(record.effect);

	if (effect.platform !== platform) {
		throw new Error("Deferred obligation belongs to another platform");
	}

	return {
		version: 1,
		kind: "deferred",
		platform: platform,
		effect: effect
	};
}

function create(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.store.read !== "function" ||
		typeof options.store.apply !== "function"
	) {
		throw new Error("Deferred obligations require a store");
	}

	var prefix = "$:/clerus/wal/" + options.platform + "/";

	function titleFor(effect) {
		return prefix + "deferred-" + effect.id;
	}

	function record(value) {
		var effect = effects.validate(value);

		if (effect.platform !== options.platform) {
			throw new Error("Cannot record a foreign deferred effect");
		}

		var title = titleFor(effect);
		var marker = JSON.stringify(effect);
		var current = options.store.read(title);

		if (current.kind !== "absent") {
			if (
				current.kind !== "materialized" ||
				current.fields.type !== "application/json" ||
				current.fields["clerus-deferred-effect"] !== marker
			) {
				throw new Error("Deferred identity is already occupied");
			}

			var body = JSON.parse(current.fields.text);
			var kind = current.fields["clerus-wal-kind"];

			if (kind === "deferred") {
				var previous = validate(body, options.platform);

				if (JSON.stringify(previous.effect) !== marker) {
					throw new Error("Deferred identity mismatch");
				}
			} else if (kind === "flow") {
				flowSchema.validate(body, options.platform);
			} else {
				throw new Error("Unsupported deferred continuation");
			}

			/*
				An existing paused obligation is not reclaimed.
				Its existence still satisfies registration.
			*/
			return title;
		}

		options.store.apply(stores.transition(title, null, {
			title: title,
			type: "application/json",
			"clerus-custody": options.platform,
			"clerus-wal-kind": "deferred",
			"clerus-deferred-effect": marker,

			text: JSON.stringify({
				version: 1,
				kind: "deferred",
				platform: options.platform,
				effect: effect
			})
		}));

		return title;
	}

	function read(title) {
		var current = options.store.read(title);

		if (
			current.kind !== "materialized" ||
			current.fields.type !== "application/json" ||
			current.fields["clerus-wal-kind"] !== "deferred" ||
			current.fields["clerus-custody"] !== options.platform
		) {
			throw new Error("Deferred obligation is not locally owned");
		}

		var body = validate(
			JSON.parse(current.fields.text),
			options.platform
		);

		if (
			title !== titleFor(body.effect) ||
			current.fields["clerus-deferred-effect"] !==
				JSON.stringify(body.effect)
		) {
			throw new Error("Deferred obligation identity mismatch");
		}

		return {
			fields: current.fields,
			effect: body.effect
		};
	}

	function checkRecipient(effect, id, recipient) {
		if (
			effect.id !== id ||
			!recipient ||
			recipient.title !== effect.recipient.title ||
			recipient.executor !== effect.recipient.executor
		) {
			throw new Error("Deferred event belongs to another recipient");
		}
	}

	function convert(loaded, record, custody) {
		var normalized = flowSchema.validate(
			record,
			options.platform
		);

		var after = schemas.copyJSON(loaded.fields);

		after["clerus-wal-kind"] = "flow";
		after["clerus-custody"] = custody;
		after.text = JSON.stringify(normalized);

		/*
			Keep clerus-deferred-effect as the durable receipt
			of the original registration.
		*/
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

			error.name = "DeferredResolutionError";
			error.cause = cause;
			error.obligationTitle = loaded.fields.title;
			error.acceptanceUncertain = true;

			throw error;
		}
	}

	function accept(title, id, value) {
		var loaded = read(title);

		var proposal = proposals.validate(value, {
			allowMessages: true,
			allowDeferred: true
		});

		checkRecipient(
			loaded.effect,
			id,
			{
				title: proposal.owner.title,
				executor: proposal.owner.executor
			}
		);

		if (proposal.owner.state === null) {
			throw new Error("Deferred reaction cannot establish its owner");
		}

		var owner = options.store.read(proposal.owner.title);

		if (
			owner.kind !== "materialized" ||
			JSON.stringify(owner.fields) !==
				JSON.stringify(proposal.owner.state)
		) {
			throw new Error("Deferred proposal owner state has changed");
		}

		/*
			Lazy loading avoids the module initialization cycle:
			the barrier also recognizes deferred obligations.
		*/
		var blockers = require(
			"$:/plugins/clerus/core2/materialization-barrier.js"
		).collect({
			store: options.store
		}).forJob(proposal.owner.title);

		if (blockers.length > 0) {
			throw new Error("Deferred recipient has unfinished materialization");
		}

		materializer.check({
			store: options.store,
			platform: options.platform,
			allowEmpty: true,

			record: {
				version: 1,
				kind: "plan",
				platform: options.platform,

				proposal: {
					version: 1,
					owner: proposal.owner,
					plan: {
						version: 1,
						effects: proposal.plan.effects
					}
				}
			}
		});

		convert(loaded, {
			version: 1,
			kind: "flow",
			platform: options.platform,
			active: proposal,
			pending: [],
			seen: {},
			errors: []
		}, options.platform);

		return "accepted";
	}

	function fail(title, id, recipient, cause) {
		var loaded = read(title);

		checkRecipient(loaded.effect, id, recipient);

		convert(loaded, {
			version: 1,
			kind: "flow",
			platform: options.platform,
			active: null,
			pending: [],
			seen: {},

			errors: [{
				event: {
					type: "tick",
					id: loaded.effect.id
				},

				owner: loaded.effect.recipient,

				error: {
					name: String(cause && cause.name || "Error"),
					message: String(cause && cause.message || cause),
					stack: cause && cause.stack
						? String(cause.stack)
						: null
				}
			}]
		}, "user");

		return "failed";
	}

	return Object.freeze({
		record: record,
		read: read,
		accept: accept,
		fail: fail
	});
}

exports.validate = validate;
exports.create = create;