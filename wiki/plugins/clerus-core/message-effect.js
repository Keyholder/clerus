/*\
title: $:/plugins/clerus/core/message-effect.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var roles = require("$:/plugins/clerus/core/roles.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var establishmentInput = require(
	"$:/plugins/clerus/core/establishment-input.js"
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

function endpoint(value, platform) {
	fieldsOnly(value, ["title", "executor"], "message endpoint");

	var space = jobTitles.classify(value.title);

	if (
		!space ||
		typeof value.executor !== "string" ||
		value.executor.length === 0
	) {
		throw new Error("Invalid message endpoint");
	}

	if (!space.persistent && space.platform !== platform) {
		throw new Error("Message endpoint belongs to another platform");
	}

	return {
		title: value.title,
		executor: value.executor
	};
}

function validate(value) {
	var source = schemas.copyJSON(value);

	fieldsOnly(source, [
		"version",
		"kind",
		"id",
		"platform",
		"type",
		"source",
		"recipient",
		"registry",
		"project",
		"role",
		"establishing"
	], "message effect");

	schemas.assertPlatform(source.platform);

	if (
		source.version !== 1 ||
		source.kind !== "official-message" ||
		typeof source.id !== "string" ||
		!/^[A-Za-z0-9_-]{16,128}$/.test(source.id) ||
		(source.type !== "order" && source.type !== "report")
	) {
		throw new Error("Invalid message effect");
	}

	if (
		source.establishing !== undefined &&
		source.establishing !== true
	) {
		throw new Error("Invalid establishment marker");
	}

	var sender = endpoint(source.source, source.platform);
	var recipient = endpoint(source.recipient, source.platform);

	if (sender.title === recipient.title) {
		throw new Error("Message endpoints must be distinct");
	}

	var result = {
		version: 1,
		kind: "official-message",
		id: source.id,
		platform: source.platform,
		type: source.type,
		source: sender,
		recipient: recipient,
		registry: schemas.registry(source.registry, "outgoing")
	};

	if (source.establishing === true) {
		if (source.type !== "order") {
			throw new Error("Establishment requires an order");
		}

		var founding = establishmentInput.read(result.registry, {
			countError:
				"Establishing message requires exactly one contract"
		});

		var contract = founding.contract;
		var recipientSpace = jobTitles.classify(recipient.title);

		if (contract.executor !== recipient.executor) {
			throw new Error(
				"Establishment executor does not match the contract"
			);
		}

		establishmentInput.assertDurability(
			contract,
			!recipientSpace.persistent,
			"Contract does not permit the recipient durability"
		);

		result.establishing = true;
	}

	if (source.type === "report") {
		if (
			typeof source.project !== "string" ||
			source.project.length === 0 ||
			!roles.isRole(source.role) ||
			source.role.length === 0
		) {
			throw new Error("Report requires a project and non-root role");
		}

		result.project = source.project;
		result.role = source.role.slice();
	} else if (
		Object.prototype.hasOwnProperty.call(source, "project") ||
		Object.prototype.hasOwnProperty.call(source, "role")
	) {
		throw new Error("Order cannot carry a report signature");
	}

	return result;
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

exports.validate = validate;
exports.fingerprint = fingerprint;