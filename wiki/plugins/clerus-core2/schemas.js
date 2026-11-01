/*\
title: $:/plugins/clerus/core2/schemas.js
type: application/javascript
module-type: library
\*/

"use strict";

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
);

function isRecord(value) {
	if (
		value === null ||
		typeof value !== "object" ||
		Array.isArray(value)
	) {
		return false;
	}

	var prototype = Object.getPrototypeOf(value);

	return prototype === Object.prototype || prototype === null;
}

function define(record, key, value) {
	Object.defineProperty(record, key, {
		value: value,
		enumerable: true,
		writable: true,
		configurable: true
	});
}

/*
Copy a JSON tree without invoking toJSON() or accessors.

Repeated references are copied independently. Cycles are rejected.
Returned records have no prototype.
*/
function copyJSON(value) {
	var ancestors = new Set();

	function visit(item) {
		if (
			item === null ||
			typeof item === "string" ||
			typeof item === "boolean"
		) {
			return item;
		}

		if (typeof item === "number") {
			if (!Number.isFinite(item)) {
				throw new Error("JSON numbers must be finite");
			}

			return item;
		}

		if (
			typeof item !== "object" ||
			(!Array.isArray(item) && !isRecord(item))
		) {
			throw new Error("Value must be a JSON tree");
		}

		if (ancestors.has(item)) {
			throw new Error("JSON tree cannot contain cycles");
		}

		if (Object.getOwnPropertySymbols(item).length !== 0) {
			throw new Error("JSON tree cannot contain symbol keys");
		}

		ancestors.add(item);

		var result;

		if (Array.isArray(item)) {
			var names = Object.getOwnPropertyNames(item);

			if (names.length !== item.length + 1) {
				throw new Error(
					"JSON arrays must be dense and have no extra properties"
				);
			}

			result = [];

			for (var index = 0; index < item.length; index++) {
				var descriptor =
					Object.getOwnPropertyDescriptor(item, String(index));

				if (
					!descriptor ||
					!hasOwn(descriptor, "value") ||
					!descriptor.enumerable
				) {
					throw new Error("Invalid JSON array entry");
				}

				result.push(visit(descriptor.value));
			}
		} else {
			result = Object.create(null);

			Object.getOwnPropertyNames(item).forEach(function (key) {
				var descriptor =
					Object.getOwnPropertyDescriptor(item, key);

				if (
					!hasOwn(descriptor, "value") ||
					!descriptor.enumerable
				) {
					throw new Error(
						"JSON records must contain enumerable data properties"
					);
				}

				define(result, key, visit(descriptor.value));
			});
		}

		ancestors.delete(item);

		return result;
	}

	return visit(value);
}

function assertPlatform(platform) {
	if (platform !== "browser" && platform !== "node") {
		throw new Error("Invalid Clerus platform");
	}

	return platform;
}

function isOrdinaryTitle(title) {
	return typeof title === "string" &&
		title.length > 0 &&
		title.indexOf("$:/") !== 0;
}

function assertKey(key) {
	if (typeof key !== "string" || key.length === 0) {
		throw new Error("Registry key must be a non-empty string");
	}

	return key;
}

function formOf(document) {
	if (isOrdinaryTitle(document)) {
		return "tiddler-title";
	}

	if (!isRecord(document)) {
		throw new Error("Invalid document serialization");
	}

	if (document.form === "charter") {
		if (!hasOwn(document, "status")) {
			throw new Error("Charter must contain status");
		}

		return "charter";
	}

	if (document.form === "memo") {
		if (!hasOwn(document, "data")) {
			throw new Error("Memo must contain data");
		}

		return "memo";
	}

	if (document.form === "mission") {
		/*
		Lazy loading avoids an initialization cycle:
		mission-schema uses the shared JSON utilities.
		*/
		require("$:/plugins/clerus/core2/mission-schema.js")
			.validate(document);

		return "mission";
	}

	throw new Error("Unsupported document form");
}

/*
Validation returns an isolated normalized value.
It never transforms one document form into another.
*/
function document(value) {
	var result = copyJSON(value);

	formOf(result);

	return result;
}

function registry(value, kind) {
	if (
		kind !== "operational" &&
		kind !== "incoming" &&
		kind !== "outgoing"
	) {
		throw new Error("Invalid registry kind");
	}

	var result = copyJSON(value);

	if (!isRecord(result)) {
		throw new Error("Registry must be a JSON record");
	}

	var charters = 0;

	Object.keys(result).forEach(function (key) {
		assertKey(key);

		if (formOf(result[key]) === "charter") {
			charters++;
		}
	});

	if (kind === "operational") {
		if (charters !== 1) {
			throw new Error(
				"Operational registry must contain exactly one charter"
			);
		}
	} else if (charters !== 0) {
		throw new Error("Transactional registry cannot contain a charter");
	}

	return result;
}

function ephemeralJob(fields, platform) {
	assertPlatform(platform);

	var snapshot = copyJSON(fields);

	if (!isRecord(snapshot)) {
		throw new Error("Job fields must be a record");
	}

	var prefix = "$:/temp/clerus/jobs/" + platform + "/";

	if (
		typeof snapshot.title !== "string" ||
		snapshot.title.indexOf(prefix) !== 0 ||
		snapshot.title.length === prefix.length
	) {
		throw new Error("Job must have a local ephemeral title");
	}

	if (snapshot.type !== "application/json") {
		throw new Error("Job must have type application/json");
	}

	if (
		typeof snapshot["clerus-executor"] !== "string" ||
		snapshot["clerus-executor"].length === 0
	) {
		throw new Error("Job must name an executor");
	}

	var custody = hasOwn(snapshot, "clerus-custody")
		? snapshot["clerus-custody"]
		: "user";

	if (custody !== "user" && custody !== platform) {
		throw new Error("Invalid custody for local ephemeral job");
	}

	if (typeof snapshot.text !== "string") {
		throw new Error("Job must contain registry JSON");
	}

	var parsed;

	try {
		parsed = JSON.parse(snapshot.text);
	} catch (error) {
		throw new Error("Invalid registry JSON: " + error.message);
	}

	return {
		title: snapshot.title,
		executor: snapshot["clerus-executor"],
		custody: custody,
		registry: registry(parsed, "operational")
	};
}

exports.isRecord = isRecord;
exports.copyJSON = copyJSON;
exports.assertPlatform = assertPlatform;
exports.isOrdinaryTitle = isOrdinaryTitle;
exports.assertKey = assertKey;
exports.formOf = formOf;
exports.document = document;
exports.registry = registry;
exports.ephemeralJob = ephemeralJob;