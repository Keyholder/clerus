/*\
title: $:/plugins/clerus/core/warrant-schema.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var missionSchema = require(
	"$:/plugins/clerus/core/mission-schema.js"
);

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
);

function assertFields(value, allowed, description) {
	if (!schemas.isRecord(value)) {
		throw new Error(description + " must be a record");
	}

	Object.keys(value).forEach(function (key) {
		if (allowed.indexOf(key) === -1) {
			throw new Error(
				"Unsupported " + description + " field: " + key
			);
		}
	});
}

function assertName(value) {
	if (typeof value !== "string" || value.length === 0) {
		throw new Error(
			"Warrant permission name must be a non-empty string"
		);
	}
}

function validateFilters(value) {
	if (
		!Array.isArray(value) ||
		value.length === 0 ||
		!value.every(function (filter) {
			return typeof filter === "string" &&
				filter.trim().length > 0;
		})
	) {
		throw new Error(
			"Warrant filters must be a non-empty array of non-empty strings"
		);
	}

	return value;
}

/*
A binding identifies a mission, but is not itself a mission document.

Delegate generation validation to mission-schema, keeping its label and
root-generation rules authoritative.
*/
function validateBinding(value) {
	var binding = schemas.copyJSON(value);

	assertFields(
		binding,
		["project", "role", "link"],
		"warrant binding"
	);

	missionSchema.validate({
		form: "mission",
		project: binding.project,
		role: binding.role,
		link: binding.link,
		issued: "0",
		children: {}
	});

	return binding;
}

function validate(value) {
	var document = schemas.copyJSON(value);

	assertFields(
		document,
		["form", "binding", "discover", "generate", "edit"],
		"warrant"
	);

	if (document.form !== "warrant") {
		throw new Error("Invalid warrant document");
	}

	if (hasOwn(document, "binding")) {
		document.binding = validateBinding(document.binding);
	}

	if (!Array.isArray(document.discover)) {
		throw new Error("Warrant discover must be an array");
	}

	var names = new Set();

	document.discover.forEach(function (permission) {
		assertFields(
			permission,
			["name", "filters"],
			"warrant discovery permission"
		);

		assertName(permission.name);

		if (names.has(permission.name)) {
			throw new Error(
				"Duplicate warrant discovery permission: " +
				permission.name
			);
		}

		names.add(permission.name);
		validateFilters(permission.filters);
	});

	["generate", "edit"].forEach(function (facet) {
		if (!Array.isArray(document[facet])) {
			throw new Error("Warrant " + facet + " must be an array");
		}

		if (document[facet].length !== 0) {
			throw new Error(
				"Warrant " + facet + " permissions are not supported yet"
			);
		}
	});

	return document;
}

/*
Attenuation is a recipe, not a replacement serialization.

Omitted discover preserves all existing discovery permissions.
Present discover explicitly selects the retained permissions.
Each entry may append independently intersected filters.

The binding cannot be changed through this structural operation.
*/
function narrow(value, specification) {
	var document = validate(value);
	var restriction = schemas.copyJSON(specification);

	assertFields(
		restriction,
		["discover"],
		"warrant restriction"
	);

	if (!hasOwn(restriction, "discover")) {
		return document;
	}

	if (!Array.isArray(restriction.discover)) {
		throw new Error(
			"Warrant discovery restriction must be an array"
		);
	}

	var available = new Map();

	document.discover.forEach(function (permission) {
		available.set(permission.name, permission);
	});

	var selected = new Set();

	document.discover = restriction.discover.map(function (entry) {
		assertFields(
			entry,
			["name", "filters"],
			"warrant discovery restriction"
		);

		assertName(entry.name);

		if (selected.has(entry.name)) {
			throw new Error(
				"Duplicate warrant discovery restriction: " +
				entry.name
			);
		}

		selected.add(entry.name);

		if (!available.has(entry.name)) {
			throw new Error(
				"Unknown warrant discovery permission: " +
				entry.name
			);
		}

		var permission = available.get(entry.name);

		if (hasOwn(entry, "filters")) {
			validateFilters(entry.filters);

			permission.filters = permission.filters.concat(
				entry.filters
			);
		}

		return permission;
	});

	return validate(document);
}

exports.validate = validate;
exports.validateBinding = validateBinding;
exports.narrow = narrow;