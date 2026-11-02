/*\
title: $:/plugins/clerus/core2/flow-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var proposals = require(
	"$:/plugins/clerus/core2/proposal-schema.js"
);
var messageEffects = require(
	"$:/plugins/clerus/core2/message-effect.js"
);

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
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

function validate(value, platform) {
	schemas.assertPlatform(platform);

	var record = schemas.copyJSON(value);

	fieldsOnly(record, [
		"version",
		"kind",
		"platform",
		"active",
		"pending",
		"seen",
		"errors"
	], "flow WAL");

	if (
		record.version !== 1 ||
		record.kind !== "flow" ||
		record.platform !== platform ||
		(record.active !== null && !schemas.isRecord(record.active)) ||
		!Array.isArray(record.pending) ||
		!schemas.isRecord(record.seen) ||
		!Array.isArray(record.errors)
	) {
		throw new Error("Invalid flow WAL");
	}

	Object.keys(record.seen).forEach(function (id) {
		if (
			!/^[A-Za-z0-9_-]{16,128}$/.test(id) ||
			typeof record.seen[id] !== "string"
		) {
			throw new Error("Invalid flow identity history");
		}
	});

	var pendingIds = new Set();

	var pending = record.pending.map(function (value) {
		var message = messageEffects.validate(value);

		if (message.platform !== platform) {
			throw new Error("Flow contains a foreign message");
		}

		if (pendingIds.has(message.id)) {
			throw new Error("Repeated pending message identity");
		}

		pendingIds.add(message.id);

		if (
			!hasOwn(record.seen, message.id) ||
			record.seen[message.id] !==
				messageEffects.fingerprint(message)
		) {
			throw new Error("Pending message identity is not registered");
		}

		return message;
	});

	var active = record.active === null
		? null
		: proposals.validate(record.active, {
			allowMessages: true
		});

	if (active !== null) {
		active.plan.messages.forEach(function (message) {
			if (message.platform !== platform) {
				throw new Error("Active plan emits a foreign message");
			}

			if (
				hasOwn(record.seen, message.id) &&
				record.seen[message.id] !==
					messageEffects.fingerprint(message)
			) {
				throw new Error("Flow message identity was reused");
			}
		});
	}

	var failedIds = new Set();

	var errors = record.errors.map(function (entry) {
		fieldsOnly(
			entry,
			["message", "error"],
			"flow branch error"
		);

		fieldsOnly(
			entry.error,
			["name", "message", "stack"],
			"branch diagnostic"
		);

		if (
			typeof entry.error.name !== "string" ||
			typeof entry.error.message !== "string" ||
			(
				entry.error.stack !== null &&
				typeof entry.error.stack !== "string"
			)
		) {
			throw new Error("Invalid branch diagnostic");
		}

		var message = messageEffects.validate(entry.message);

		if (
			message.platform !== platform ||
			failedIds.has(message.id) ||
			pendingIds.has(message.id)
		) {
			throw new Error("Invalid failed message identity");
		}

		if (
			!hasOwn(record.seen, message.id) ||
			record.seen[message.id] !==
				messageEffects.fingerprint(message)
		) {
			throw new Error("Failed message identity is not registered");
		}

		failedIds.add(message.id);

		return {
			message: message,
			error: {
				name: entry.error.name,
				message: entry.error.message,
				stack: entry.error.stack
			}
		};
	});

	return {
		version: 1,
		kind: "flow",
		platform: platform,
		active: active,
		pending: pending,
		seen: record.seen,
		errors: errors
	};
}

exports.validate = validate;