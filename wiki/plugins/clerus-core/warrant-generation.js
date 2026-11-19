/*\
title: $:/plugins/clerus/core/warrant-generation.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");

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

function assertField(name) {
	if (
		typeof name !== "string" ||
		!/^[A-Za-z0-9_.-]+$/.test(name) ||
		name === "title" ||
		name.indexOf("clerus-") === 0
	) {
		throw new Error("Invalid warrant generation field: " + name);
	}
}

function validateInputFields(value) {
	if (!Array.isArray(value)) {
		throw new Error("Generator inputFields must be an array");
	}

	var names = new Set();

	value.forEach(function (name) {
		assertField(name);

		if (names.has(name)) {
			throw new Error("Duplicate generator input field: " + name);
		}

		names.add(name);
	});
}

function validate(value) {
	var template = schemas.copyJSON(value);

	assertFields(
		template,
		["name", "titlePrefix", "fields", "inputFields"],
		"warrant generator"
	);

	if (
		typeof template.name !== "string" ||
		template.name.length === 0
	) {
		throw new Error("Generator name must be non-empty");
	}

	if (!schemas.isOrdinaryTitle(template.titlePrefix)) {
		throw new Error("Generator requires an ordinary title prefix");
	}

	if (!schemas.isRecord(template.fields)) {
		throw new Error("Generator fields must be a record");
	}

	Object.keys(template.fields).forEach(function (name) {
		assertField(name);

		if (typeof template.fields[name] !== "string") {
			throw new Error("Generator field values must be strings");
		}
	});

	validateInputFields(template.inputFields);

	template.inputFields.forEach(function (name) {
		if (hasOwn(template.fields, name)) {
			throw new Error(
				"Generator input overlaps a fixed field: " + name
			);
		}
	});

	return template;
}

function validateList(value) {
	if (!Array.isArray(value)) {
		throw new Error("Warrant generate must be an array");
	}

	var names = new Set();

	return value.map(function (entry) {
		var template = validate(entry);

		if (names.has(template.name)) {
			throw new Error("Duplicate warrant generator: " + template.name);
		}

		names.add(template.name);
		return template;
	});
}

function narrow(values, specification) {
	var templates = validateList(values);
	var restriction = schemas.copyJSON(specification);

	if (!Array.isArray(restriction)) {
		throw new Error("Generator restriction must be an array");
	}

	var available = new Map();
	var selected = new Set();

	templates.forEach(function (template) {
		available.set(template.name, template);
	});

	return restriction.map(function (entry) {
		assertFields(
			entry,
			["name", "titlePrefix", "inputFields"],
			"generator restriction"
		);

		if (
			typeof entry.name !== "string" ||
			!available.has(entry.name)
		) {
			throw new Error("Unknown warrant generator: " + entry.name);
		}

		if (selected.has(entry.name)) {
			throw new Error(
				"Duplicate generator restriction: " + entry.name
			);
		}

		selected.add(entry.name);

		var template = available.get(entry.name);

		if (hasOwn(entry, "titlePrefix")) {
			if (
				typeof entry.titlePrefix !== "string" ||
				entry.titlePrefix.indexOf(template.titlePrefix) !== 0
			) {
				throw new Error("Generator title prefix cannot be widened");
			}

			template.titlePrefix = entry.titlePrefix;
		}

		if (hasOwn(entry, "inputFields")) {
			validateInputFields(entry.inputFields);

			entry.inputFields.forEach(function (name) {
				if (template.inputFields.indexOf(name) === -1) {
					throw new Error(
						"Generator input fields cannot be widened"
					);
				}
			});

			template.inputFields = entry.inputFields.slice();
		}

		return validate(template);
	});
}

function instantiate(value, input, title, platform) {
	var template = validate(value);
	var parameters = schemas.copyJSON(input);

	schemas.assertPlatform(platform);

	if (
		!schemas.isOrdinaryTitle(title) ||
		title.indexOf(template.titlePrefix) !== 0 ||
		title.length === template.titlePrefix.length
	) {
		throw new Error("Invalid generated title");
	}

	if (!schemas.isRecord(parameters)) {
		throw new Error("Generator parameters must be a record");
	}

	var fields = schemas.copyJSON(template.fields);

	Object.keys(parameters).forEach(function (name) {
		if (template.inputFields.indexOf(name) === -1) {
			throw new Error("Generator input field is not allowed: " + name);
		}

		if (typeof parameters[name] !== "string") {
			throw new Error("Generator input values must be strings");
		}

		Object.defineProperty(fields, name, {
			value: parameters[name],
			enumerable: true,
			writable: true,
			configurable: true
		});
	});

	fields.title = title;
	fields["clerus-custody"] = platform;

	return fields;
}

exports.validate = validate;
exports.validateList = validateList;
exports.narrow = narrow;
exports.instantiate = instantiate;