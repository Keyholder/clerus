/*\
title: $:/plugins/clerus/core/event-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var roles = require("$:/plugins/clerus/core/roles.js");
var establishmentInput = require(
	"$:/plugins/clerus/core/establishment-input.js"
);
var notifications = require(
	"$:/plugins/clerus/core/notification-schema.js"
);

var hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);

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

function identity(value) {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9_-]{16,128}$/.test(value)
	) {
		throw new Error("Invalid event identity");
	}

	return value;
}

function validate(value) {
	var event = schemas.copyJSON(value);

	if (
		schemas.isRecord(event) &&
		event.kind === "notification"
	) {
		fieldsOnly(event, [
			"kind", "recipient", "notification"
		], "notification event");

		fieldsOnly(event.recipient, [
			"title", "executor"
		], "notification recipient");

		var notificationSpace = jobTitles.classify(
			event.recipient.title
		);

		if (
			!notificationSpace ||
			!notificationSpace.persistent ||
			typeof event.recipient.executor !== "string" ||
			event.recipient.executor.length === 0
		) {
			throw new Error(
				"Notification requires a persistent recipient"
			);
		}

		return schemas.copyJSON({
			kind: "notification",
			recipient: {
				title: event.recipient.title,
				executor: event.recipient.executor
			},
			notification: notifications.validate(event.notification)
		});
	}

	if (
		schemas.isRecord(event) &&
		event.kind === "activation"
	) {
		fieldsOnly(event, [
			"kind", "recipient"
		], "activation event");

		fieldsOnly(event.recipient, [
			"title", "executor"
		], "activation recipient");

		var activationSpace = jobTitles.classify(
			event.recipient.title
		);

		if (
			!activationSpace ||
			!activationSpace.persistent ||
			typeof event.recipient.executor !== "string" ||
			event.recipient.executor.length === 0
		) {
			throw new Error(
				"Activation requires a persistent recipient"
			);
		}

		return schemas.copyJSON({
			kind: "activation",
			recipient: {
				title: event.recipient.title,
				executor: event.recipient.executor
			}
		});
	}

	fieldsOnly(event, [
		"kind",
		"recipient",
		"type",
		"registry",
		"project",
		"role",
		"establishing"
	], "event");

	fieldsOnly(event.recipient, [
		"title", "executor"
	], "event recipient");

	var space = jobTitles.classify(event.recipient.title);

	if (
		event.kind !== "delivery" ||
		(event.type !== "order" && event.type !== "report") ||
		!space ||
		typeof event.recipient.executor !== "string" ||
		event.recipient.executor.length === 0
	) {
		throw new Error(
			"Event requires a delivery to a persistent job"
		);
	}

	var result = {
		kind: "delivery",
		recipient: {
			title: event.recipient.title,
			executor: event.recipient.executor
		},
		type: event.type,
		registry: schemas.registry(event.registry, "incoming")
	};

	if (event.type === "report") {
		if (
			typeof event.project !== "string" ||
			event.project.length === 0 ||
			!roles.isRole(event.role) ||
			event.role.length === 0
		) {
			throw new Error(
				"Report event requires a project and non-root role"
			);
		}

		result.project = event.project;
		result.role = event.role.slice();
	} else if (
		hasOwn(event, "project") ||
		hasOwn(event, "role")
	) {
		throw new Error("Order event cannot carry a report signature");
	}

	if (hasOwn(event, "establishing")) {
		if (
			event.establishing !== true ||
			event.type !== "order"
		) {
			throw new Error(
				"Establishment requires an order"
			);
		}

		var founding = establishmentInput.read(
			result.registry,
			{ temporary: !space.persistent }
		);

		if (
			founding.contract.executor !==
				result.recipient.executor
		) {
			throw new Error(
				"Establishment executor does not match the contract"
			);
		}

		result.establishing = true;
	}

	return schemas.copyJSON(result);
}

function emission(value) {
	var source = schemas.copyJSON(value);

	fieldsOnly(source, ["id", "event"], "event emission");

	return {
		id: identity(source.id),
		event: validate(source.event)
	};
}

function canonical(value) {
	if (Array.isArray(value)) {
		return value.map(canonical);
	}

	if (schemas.isRecord(value)) {
		var result = Object.create(null);

		Object.keys(value).sort().forEach(function (key) {
			Object.defineProperty(result, key, {
				value: canonical(value[key]),
				enumerable: true,
				writable: true,
				configurable: true
			});
		});

		return result;
	}

	return value;
}

function fingerprint(value) {
	return JSON.stringify(canonical(validate(value)));
}

function assertPlatform(value, platform) {
	schemas.assertPlatform(platform);

	var event = validate(value);
	var space = jobTitles.classify(event.recipient.title);

	if (
		!space.persistent &&
		space.platform !== platform
	) {
		throw new Error(
			"Event addresses a foreign ephemeral recipient"
		);
	}

	return event;
}

exports.identity = identity;
exports.validate = validate;
exports.emission = emission;
exports.fingerprint = fingerprint;
exports.assertPlatform = assertPlatform;