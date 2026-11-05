/*\
title: $:/plugins/clerus/core/establishment-input.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");

function assertDurability(value, temporary, diagnostic) {
	if (typeof temporary !== "boolean") {
		throw new Error("Establishment durability must be boolean");
	}

	if (
		diagnostic !== undefined &&
		(
			typeof diagnostic !== "string" ||
			diagnostic.length === 0
		)
	) {
		throw new Error("Contract durability diagnostic must be non-empty");
	}

	var contract = schemas.document(value);

	if (schemas.formOf(contract) !== "contract") {
		throw new Error("Establishment requires a contract");
	}

	if (temporary && contract.temp === false) {
		throw new Error(
			diagnostic ||
			"Contract forbids ephemeral establishment"
		);
	}

	if (!temporary && contract.temp === true) {
		throw new Error(
			diagnostic ||
			"Contract forbids persistent establishment"
		);
	}
}

function read(value, options) {
	options = options || {};

	if (
		options.temporary !== undefined &&
		typeof options.temporary !== "boolean"
	) {
		throw new Error("Establishment durability must be boolean");
	}

	if (
		options.countError !== undefined &&
		(
			typeof options.countError !== "string" ||
			options.countError.length === 0
		)
	) {
		throw new Error("Contract count diagnostic must be non-empty");
	}

	if (
		options.durabilityError !== undefined &&
		(
			typeof options.durabilityError !== "string" ||
			options.durabilityError.length === 0
		)
	) {
		throw new Error("Contract durability diagnostic must be non-empty");
	}

	var registry = schemas.registry(value, "incoming");

	var keys = Object.keys(registry).filter(function (key) {
		return schemas.formOf(registry[key]) === "contract";
	});

	if (keys.length !== 1) {
		throw new Error(
			options.countError ||
			"Establishment requires exactly one incoming contract"
		);
	}

	var key = keys[0];
	var contract = registry[key];

	if (options.temporary !== undefined) {
		assertDurability(
			contract,
			options.temporary,
			options.durabilityError
		);
	}

	return {
		key: key,
		contract: contract
	};
}

exports.read = read;
exports.assertDurability = assertDurability;