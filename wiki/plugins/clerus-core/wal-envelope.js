/*\
title: $:/plugins/clerus/core/wal-envelope.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");

var KINDS = [
	"plan", "flow", "deferred", "incident", "continuation"
];

function supports(version, kind) {
	if (version === 1) {
		return (
			kind === "plan" ||
			kind === "flow" ||
			kind === "deferred" ||
			kind === "incident"
		);
	}

	return version === 2 && kind === "continuation";
}

function platformOf(title) {
	if (typeof title !== "string") {
		return null;
	}

	if (title.indexOf("$:/clerus/wal/browser/") === 0) {
		return "browser";
	}

	if (title.indexOf("$:/clerus/wal/node/") === 0) {
		return "node";
	}

	return null;
}

function unavailable(kind, platform, reason) {
	return {
		kind: kind,
		platform: platform,
		record: null,
		reason: reason
	};
}

/*
Read only the outer materialized WAL envelope.

"ready" means that the envelope selects a supported body schema.
It does not mean that the body is valid or executable.

Input contract failures are not serialized-data failures.
*/
function read(fields) {
	var source = schemas.copyJSON(fields);

	if (!schemas.isRecord(source)) {
		throw new Error("WAL reading requires field records");
	}

	var platform = platformOf(source.title);

	if (platform === null) {
		throw new Error("WAL reading requires a WAL title");
	}

	if (
		source.type !== "application/json" ||
		typeof source.text !== "string"
	) {
		return unavailable(
			"unreadable",
			platform,
			"WAL must contain application/json text"
		);
	}

	var record;

	try {
		record = JSON.parse(source.text);
	} catch (error) {
		return unavailable(
			"unreadable",
			platform,
			"Invalid WAL JSON: " + error.message
		);
	}

	if (
		!schemas.isRecord(record) ||
		record.platform !== platform ||
		typeof record.kind !== "string" ||
		record.kind.length === 0 ||
		record.kind !== source["clerus-wal-kind"] ||
		!Number.isSafeInteger(record.version) ||
		record.version < 1
	) {
		return unavailable(
			"unreadable",
			platform,
			"Invalid WAL envelope"
		);
	}

	if (record.version !== 1 && record.version !== 2) {
		return unavailable(
			"unsupported",
			platform,
			"Unsupported WAL version: " + record.version
		);
	}

	if (!supports(record.version, record.kind)) {
		return unavailable(
			"unsupported",
			platform,
			"Unsupported WAL version/kind combination: " +
				record.version + "/" + record.kind
		);
	}

	return {
		kind: "ready",
		platform: platform,
		record: record,
		reason: null
	};
}

/*
Require a supported outer envelope of the expected platform/kind.

This does not validate the kind-specific body and does not
authorize execution or reclaim user custody.
*/
function requireRecord(fields, platform, kind) {
	schemas.assertPlatform(platform);

	if (KINDS.indexOf(kind) === -1) {
		throw new Error("Invalid expected WAL kind");
	}

	var envelope = read(fields);

	if (envelope.kind !== "ready") {
		throw new Error(envelope.reason);
	}

	if (envelope.platform !== platform) {
		throw new Error("WAL envelope belongs to another platform");
	}

	if (envelope.record.kind !== kind) {
		throw new Error("Unexpected WAL kind: " + envelope.record.kind);
	}

	return envelope.record;
}

exports.platformOf = platformOf;
exports.read = read;
exports.requireRecord = requireRecord;