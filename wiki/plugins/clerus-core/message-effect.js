/*\
title: $:/plugins/clerus/core/message-effect.js
type: application/javascript
module-type: library
\*/

"use strict";

var copyJSON = require("$:/plugins/clerus/core/json.js").copy;
var documentFlow =
	require("$:/plugins/clerus/core/document-flow.js");
var roles = require("$:/plugins/clerus/core/roles.js");

function isRecord(value) {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value);
}

function validEndpoint(endpoint) {
	if (
		!isRecord(endpoint) ||
		typeof endpoint.title !== "string" ||
		typeof endpoint.executor !== "string" ||
		!endpoint.executor ||
		(endpoint.platform !== "browser" && endpoint.platform !== "node")
	) {
		return false;
	}

	return (
		endpoint.title.indexOf("$:/clerus/jobs/") === 0 ||
		endpoint.title.indexOf(
			"$:/temp/clerus/jobs/" + endpoint.platform + "/"
		) === 0
	);
}

function validate(effect) {
	if (
		!isRecord(effect) ||
		effect.version !== 1 ||
		effect.kind !== "official-message" ||
		typeof effect.id !== "string" ||
		!/^[A-Za-z0-9_-]+$/.test(effect.id) ||
		(effect.message !== "order" && effect.message !== "report") ||
		!validEndpoint(effect.source) ||
		!validEndpoint(effect.recipient) ||
		effect.source.platform !== effect.recipient.platform ||
		!isRecord(effect.registry)
	) {
		throw new Error("Invalid official message effect");
	}

	if (effect.message === "report") {
		if (
			typeof effect.project !== "string" ||
			!effect.project ||
			!roles.isRole(effect.role) ||
			effect.role.length === 0
		) {
			throw new Error("Report requires a project and non-root role");
		}
	} else if (
		Object.prototype.hasOwnProperty.call(effect, "project") ||
		Object.prototype.hasOwnProperty.call(effect, "role")
	) {
		throw new Error("Order must not carry a report signature");
	}

	Object.keys(effect.registry).forEach(function (key) {
		var document = effect.registry[key];

		if (
			!isRecord(document) ||
			document.form !== "memo" ||
			!Object.prototype.hasOwnProperty.call(document, "data")
		) {
			throw new Error("Message effects currently carry only memos");
		}
	});

	// Also reject non-JSON payloads.
	copyJSON(effect);
}

function freeze(value) {
	if (value && typeof value === "object") {
		Object.keys(value).forEach(function (key) {
			freeze(value[key]);
		});

		Object.freeze(value);
	}

	return value;
}

function create(options, rules) {
	var delivery = documentFlow.prepare(
		options.registry,
		{
			type: options.message,
			establishing: false
		},
		rules
	);

	if (
		Object.keys(delivery.automatic).length > 0 ||
		delivery.entries.some(function (entry) {
			return entry.transfer !== "copy";
		})
	) {
		throw new Error("Message effects require explicitly received copies");
	}

	var effect = {
		version: 1,
		kind: "official-message",
		id: options.id,
		message: options.message,
		source: copyJSON(options.source),
		recipient: copyJSON(options.recipient),
		registry: copyJSON(delivery.registry)
	};

	if (options.message === "report") {
		effect.project = options.project;
		effect.role = copyJSON(options.role);
	}

	validate(effect);

	return freeze(effect);
}

function event(effect) {
	validate(effect);

	var result = {
		type: effect.message,
		id: effect.id,
		title: effect.recipient.title,
		platform: effect.recipient.platform
	};

	if (effect.message === "report") {
		result.project = effect.project;
		result.role = effect.role.slice();
	}

	return freeze(result);
}

exports.create = create;
exports.validate = validate;
exports.event = event;