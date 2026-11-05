/*\
title: $:/plugins/clerus/core/incident-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");

/*
Version 1 historical incident envelope.

The diagnostic payload is intentionally opaque. It does not
represent executable work or establish retention grounds.
*/
function validate(value, platform) {
	schemas.assertPlatform(platform);

	var record = schemas.copyJSON(value);

	if (
		!schemas.isRecord(record) ||
		Object.keys(record).some(function (key) {
			return [
				"version", "kind", "platform", "incident"
			].indexOf(key) === -1;
		}) ||
		record.version !== 1 ||
		record.kind !== "incident" ||
		record.platform !== platform ||
		!schemas.isRecord(record.incident)
	) {
		throw new Error("Invalid incident envelope");
	}

	return record;
}

function read(fields, platform) {
	if (
		!schemas.isRecord(fields) ||
		fields.type !== "application/json" ||
		fields["clerus-wal-kind"] !== "incident" ||
		typeof fields.text !== "string"
	) {
		throw new Error("Invalid incident tiddler envelope");
	}

	return validate(JSON.parse(fields.text), platform);
}

exports.validate = validate;
exports.read = read;