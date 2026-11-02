/*\
title: $:/plugins/clerus/core/mission-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var roles = require("$:/plugins/clerus/core/roles.js");
var generations = require(
	"$:/plugins/clerus/core/generations.js"
);

function validate(value) {
	var document = schemas.copyJSON(value);

	if (
		!schemas.isRecord(document) ||
		document.form !== "mission" ||
		typeof document.project !== "string" ||
		document.project.length === 0 ||
		!roles.isRole(document.role) ||
		!generations.isLabel(document.link) ||
		!generations.isOrdinal(document.issued) ||
		!schemas.isRecord(document.children)
	) {
		throw new Error("Invalid mission document");
	}

	if (
		document.role.length === 0 &&
		!generations.isOrdinal(document.link)
	) {
		throw new Error("Root mission requires an ordinal generation");
	}

	Object.keys(document.children).forEach(function (segment) {
		if (
			!roles.isSegment(segment) ||
			!generations.isLabel(document.children[segment])
		) {
			throw new Error("Invalid child mission binding");
		}
	});

	return document;
}

function identity(value) {
	var document = validate(value);

	return JSON.stringify([
		document.project,
		document.role,
		document.link
	]);
}

function delegationSignature(value) {
	var document = validate(value);

	return JSON.stringify([
		document.issued,
		Object.keys(document.children).sort().map(function (segment) {
			return [segment, document.children[segment]];
		})
	]);
}

exports.validate = validate;
exports.identity = identity;
exports.delegationSignature = delegationSignature;