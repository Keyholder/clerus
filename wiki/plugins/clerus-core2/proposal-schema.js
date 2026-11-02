/*\
title: $:/plugins/clerus/core2/proposal-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var stores = require("$:/plugins/clerus/core2/store.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");
var messageEffects = require(
	"$:/plugins/clerus/core2/message-effect.js"
);
var deferredEffects = require(
	"$:/plugins/clerus/core2/deferred-effect.js"
);

function fieldsOnly(record, allowed, description) {
	if (
		!schemas.isRecord(record) ||
		Object.keys(record).some(function (key) {
			return allowed.indexOf(key) === -1;
		})
	) {
		throw new Error("Unsupported fields in " + description);
	}
}

function normalizeFields(fields) {
	if (!schemas.isRecord(fields)) {
		throw new Error("Expected tiddler fields");
	}

	return stores.transition(
		fields.title,
		fields,
		fields
	).after;
}

function validate(value, options) {
	options = options || {};

	var proposal = schemas.copyJSON(value);

	fieldsOnly(proposal, [
		"version", "owner", "plan"
	], "proposal");

	fieldsOnly(proposal.owner, [
		"title", "executor", "state"
	], "proposal owner");

	fieldsOnly(proposal.plan, [
		"version", "effects", "messages", "deferred"
	], "proposal plan");

	var space = jobTitles.classify(proposal.owner.title);

	if (
		proposal.version !== 1 ||
		proposal.plan.version !== 1 ||
		!space ||
		!space.persistent ||
		typeof proposal.owner.executor !== "string" ||
		proposal.owner.executor.length === 0 ||
		!Object.prototype.hasOwnProperty.call(proposal.owner, "state") ||
		!Array.isArray(proposal.plan.effects)
	) {
		throw new Error("Invalid work proposal");
	}

	var state = proposal.owner.state === null
		? null
		: normalizeFields(proposal.owner.state);

	if (state !== null) {
		if (
			state.title !== proposal.owner.title ||
			state.type !== "application/json" ||
			state["clerus-executor"] !== proposal.owner.executor
		) {
			throw new Error("Invalid proposal owner baseline");
		}

		schemas.registry(JSON.parse(state.text), "operational");
	}

	var seen = new Set();
	var ownerEffect = null;

	var effects = proposal.plan.effects.map(function (value) {
		fieldsOnly(value, [
			"version", "title", "before", "after"
		], "material transition");

		if (value.version !== 1) {
			throw new Error("Invalid material transition version");
		}

		var effect = stores.transition(
			value.title,
			value.before,
			value.after
		);

		if (seen.has(effect.title)) {
			throw new Error("Repeated proposal target");
		}

		seen.add(effect.title);

		if (effect.title === proposal.owner.title) {
			ownerEffect = effect;

			if (
				effect.after === null ||
				JSON.stringify(effect.before) !== JSON.stringify(state) ||
				effect.after.type !== "application/json" ||
				effect.after["clerus-executor"] !== proposal.owner.executor
			) {
				throw new Error("Invalid proposal owner transition");
			}

			schemas.registry(
				JSON.parse(effect.after.text),
				"operational"
			);
		} else if (!schemas.isOrdinaryTitle(effect.title)) {
			throw new Error(
				"External proposal target must be an ordinary tiddler"
			);
		}

		return effect;
	});

	if (state === null && ownerEffect === null) {
		throw new Error("Birth proposal must create its owner");
	}

	var messages = [];

	if (proposal.plan.messages !== undefined) {
		if (!Array.isArray(proposal.plan.messages)) {
			throw new Error("Proposal messages must be an array");
		}

		if (
			proposal.plan.messages.length > 0 &&
			options.allowMessages !== true
		) {
			throw new Error(
				"Message-bearing proposal requires a transactional flow"
			);
		}

		var messageIds = new Set();

		messages = proposal.plan.messages.map(function (value) {
			var message = messageEffects.validate(value);

			if (messageIds.has(message.id)) {
				throw new Error("Repeated proposal message identity");
			}

			messageIds.add(message.id);

			if (
				message.source.title !== proposal.owner.title ||
				message.source.executor !== proposal.owner.executor
			) {
				throw new Error("Proposal message has another sender");
			}

			return message;
		});
	}

	var deferred = [];

	if (proposal.plan.deferred !== undefined) {
		if (!Array.isArray(proposal.plan.deferred)) {
			throw new Error("Proposal deferred effects must be an array");
		}

		if (
			proposal.plan.deferred.length > 0 &&
			options.allowDeferred !== true
		) {
			throw new Error(
				"Deferred proposal requires deferred-obligation support"
			);
		}

		var deferredRecipients = new Set();
		var deferredIds = new Set();

		deferred = proposal.plan.deferred.map(function (value) {
			var effect = deferredEffects.validate(value);

			if (
				effect.recipient.title !== proposal.owner.title ||
				effect.recipient.executor !== proposal.owner.executor
			) {
				throw new Error(
					"Deferred effect must address the reacting owner"
				);
			}

			if (
				deferredRecipients.has(effect.recipient.title) ||
				deferredIds.has(effect.id)
			) {
				throw new Error("Repeated proposal deferred effect");
			}

			deferredRecipients.add(effect.recipient.title);
			deferredIds.add(effect.id);

			return effect;
		});
	}

	var result = {
		version: 1,
		owner: {
			title: proposal.owner.title,
			executor: proposal.owner.executor,
			state: state
		},
		plan: {
			version: 1,
			effects: effects
		}
	};

	if (options.allowMessages === true) {
		result.plan.messages = messages;
	}

	if (options.allowDeferred === true) {
		result.plan.deferred = deferred;
	}

	return schemas.copyJSON(result);
}

exports.validate = validate;