/*\
title: $:/plugins/clerus/core/custody-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var envelopes = require("$:/plugins/clerus/core/wal-envelope.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");

var hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);

var TRANSFER_FIELD = "clerus-custody-transfer";
var EVIDENCE_PREFIX = "$:/clerus/custody/";

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

function workIdentity(value) {
	if (
		typeof value !== "string" ||
		!/^[A-Za-z0-9_-]{16,128}$/.test(value)
	) {
		throw new Error("Invalid custody transfer work identity");
	}

	return value;
}

function journalPlatform(title) {
	var platform = envelopes.platformOf(title);

	if (
		platform === null ||
		title.length ===
			("$:/clerus/wal/" + platform + "/").length
	) {
		throw new Error("Invalid custody transfer journal");
	}

	return platform;
}

function transfer(value) {
	var record = schemas.copyJSON(value);

	fieldsOnly(record, [
		"version", "journal", "work", "from", "to"
	], "custody transfer");

	if (record.version !== 1) {
		throw new Error("Unsupported custody transfer version");
	}

	schemas.assertPlatform(record.from);
	schemas.assertPlatform(record.to);
	workIdentity(record.work);

	if (
		record.from === record.to ||
		journalPlatform(record.journal) !== record.from
	) {
		throw new Error("Invalid custody transfer direction");
	}

	return schemas.copyJSON({
		version: 1,
		journal: record.journal,
		work: record.work,
		from: record.from,
		to: record.to
	});
}

/*
Read the protocol marker, not execution readiness.

No marker means no transfer constraint is serialized here.
A malformed marker must not silently become its absence.
*/
function readTransfer(fields) {
	var source = schemas.copyJSON(fields);

	if (!schemas.isRecord(source)) {
		throw new Error("Custody transfer requires tiddler fields");
	}

	if (!hasOwn(source, TRANSFER_FIELD)) {
		return null;
	}

	var space = jobTitles.classify(source.title);

	if (!space || !space.persistent) {
		throw new Error(
			"Custody transfer marker requires a persistent job"
		);
	}

	if (typeof source[TRANSFER_FIELD] !== "string") {
		throw new Error("Custody transfer marker must be JSON text");
	}

	var parsed;

	try {
		parsed = JSON.parse(source[TRANSFER_FIELD]);
	} catch (error) {
		throw new Error("Invalid custody transfer marker JSON");
	}

	var record = transfer(parsed);

	if (source["clerus-custody"] !== record.to) {
		throw new Error(
			"Custody transfer destination does not match assignment"
		);
	}

	return record;
}

function deletion(value, platform) {
	schemas.assertPlatform(platform);

	var record = schemas.copyJSON(value);

	fieldsOnly(record, [
		"version", "kind", "platform", "journal"
	], "WAL deletion evidence");

	if (
		record.version !== 1 ||
		record.kind !== "wal-deletion" ||
		record.platform !== platform
	) {
		throw new Error("Invalid WAL deletion evidence");
	}

	if (journalPlatform(record.journal) === platform) {
		throw new Error(
			"Incoming deletion evidence requires another source platform"
		);
	}

	return schemas.copyJSON({
		version: 1,
		kind: "wal-deletion",
		platform: platform,
		journal: record.journal
	});
}

function deletionTitle(platform, journal) {
	var record = deletion({
		version: 1,
		kind: "wal-deletion",
		platform: platform,
		journal: journal
	}, platform);

	return EVIDENCE_PREFIX + platform +
		"/wal-deletions/" +
		encodeURIComponent(record.journal);
}

function readDeletion(fields, platform) {
	var source = schemas.copyJSON(fields);

	if (
		!schemas.isRecord(source) ||
		source.type !== "application/json" ||
		source["clerus-custody-kind"] !== "wal-deletion" ||
		typeof source.text !== "string"
	) {
		throw new Error("Invalid WAL deletion evidence envelope");
	}

	var parsed;

	try {
		parsed = JSON.parse(source.text);
	} catch (error) {
		throw new Error("Invalid WAL deletion evidence JSON");
	}

	var record = deletion(parsed, platform);

	if (
		source.title !==
			deletionTitle(platform, record.journal)
	) {
		throw new Error("WAL deletion evidence address mismatch");
	}

	return record;
}

function assertWorkBinding(work, platform, journal) {
	schemas.assertPlatform(platform);

	if (journalPlatform(journal) !== platform) {
		throw new Error("Work journal belongs to another platform");
	}

	work.transitions.forEach(function (effect) {
		if (
			!jobTitles.isJobTitle(effect.title) ||
			effect.before === null ||
			effect.after === null ||
			effect.before["clerus-custody"] ===
				effect.after["clerus-custody"]
		) {
			return;
		}

		var marker = readTransfer(effect.after);

		if (
			marker === null ||
			marker.journal !== journal ||
			marker.work !== work.id ||
			marker.from !== platform ||
			marker.from !== effect.before["clerus-custody"] ||
			marker.to !== effect.after["clerus-custody"]
		) {
			throw new Error(
				"Custody transfer is not bound to its accepted work journal"
			);
		}
	});

	return true;
}

exports.TRANSFER_FIELD = TRANSFER_FIELD;
exports.transfer = transfer;
exports.readTransfer = readTransfer;
exports.deletion = deletion;
exports.deletionTitle = deletionTitle;
exports.readDeletion = readDeletion;
exports.assertWorkBinding = assertWorkBinding;