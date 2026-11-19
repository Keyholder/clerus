/*\
title: $:/plugins/clerus/core/warrant-editing.js
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
		throw new Error("Invalid warrant editing field: " + name);
	}
}

function validateFields(value) {
	if (!Array.isArray(value)) {
		throw new Error("Editing fields must be an array");
	}

	var names = new Set();

	value.forEach(function (name) {
		assertField(name);

		if (names.has(name)) {
			throw new Error("Duplicate editing field: " + name);
		}

		names.add(name);
	});
}

function validate(value) {
	var permission = schemas.copyJSON(value);

	assertFields(
		permission,
		["name", "target", "setFields", "removeFields"],
		"warrant editing permission"
	);

	if (
		typeof permission.name !== "string" ||
		permission.name.length === 0
	) {
		throw new Error("Editing permission name must be non-empty");
	}

	assertFields(
		permission.target,
		["titlePrefix"],
		"warrant editing target"
	);

	if (!schemas.isOrdinaryTitle(permission.target.titlePrefix)) {
		throw new Error(
			"Editing target requires an ordinary title prefix"
		);
	}

	validateFields(permission.setFields);
	validateFields(permission.removeFields);

	return permission;
}

function validateList(value) {
	if (!Array.isArray(value)) {
		throw new Error("Warrant edit must be an array");
	}

	var names = new Set();

	return value.map(function (entry) {
		var permission = validate(entry);

		if (names.has(permission.name)) {
			throw new Error(
				"Duplicate warrant editing permission: " +
				permission.name
			);
		}

		names.add(permission.name);
		return permission;
	});
}

function narrow(values, specification) {
	var permissions = validateList(values);
	var restriction = schemas.copyJSON(specification);

	if (!Array.isArray(restriction)) {
		throw new Error("Editing restriction must be an array");
	}

	var available = new Map();
	var selected = new Set();

	permissions.forEach(function (permission) {
		available.set(permission.name, permission);
	});

	return restriction.map(function (entry) {
		assertFields(
			entry,
			["name", "target", "setFields", "removeFields"],
			"editing restriction"
		);

		if (
			typeof entry.name !== "string" ||
			!available.has(entry.name)
		) {
			throw new Error(
				"Unknown warrant editing permission: " + entry.name
			);
		}

		if (selected.has(entry.name)) {
			throw new Error(
				"Duplicate editing restriction: " + entry.name
			);
		}

		selected.add(entry.name);

		var permission = available.get(entry.name);

		if (hasOwn(entry, "target")) {
			assertFields(
				entry.target,
				["titlePrefix"],
				"editing target restriction"
			);

			if (
				typeof entry.target.titlePrefix !== "string" ||
				entry.target.titlePrefix.indexOf(
					permission.target.titlePrefix
				) !== 0
			) {
				throw new Error(
					"Editing target prefix cannot be widened"
				);
			}

			permission.target.titlePrefix = entry.target.titlePrefix;
		}

		["setFields", "removeFields"].forEach(function (facet) {
			if (!hasOwn(entry, facet)) {
				return;
			}

			validateFields(entry[facet]);

			entry[facet].forEach(function (name) {
				if (permission[facet].indexOf(name) === -1) {
					throw new Error(
						"Editing fields cannot be widened"
					);
				}
			});

			permission[facet] = entry[facet].slice();
		});

		return validate(permission);
	});
}

function transform(value, fields, specification) {
	var permission = validate(value);
	var before = schemas.copyJSON(fields);
	var change = schemas.copyJSON(specification);

	if (
		!schemas.isRecord(before) ||
		!schemas.isOrdinaryTitle(before.title) ||
		before.title.indexOf(permission.target.titlePrefix) !== 0
	) {
		throw new Error(
			"Title is outside warrant editing permission"
		);
	}

	assertFields(change, ["set", "remove"], "warrant edit");

	if (!hasOwn(change, "set")) {
		change.set = Object.create(null);
	}

	if (!hasOwn(change, "remove")) {
		change.remove = [];
	}

	if (!schemas.isRecord(change.set)) {
		throw new Error("Warrant edit set must be a record");
	}

	validateFields(change.remove);

	Object.keys(change.set).forEach(function (name) {
		assertField(name);

		if (permission.setFields.indexOf(name) === -1) {
			throw new Error("Setting field is not allowed: " + name);
		}

		if (typeof change.set[name] !== "string") {
			throw new Error("Edited field values must be strings");
		}

		if (change.remove.indexOf(name) !== -1) {
			throw new Error(
				"Cannot set and remove the same field"
			);
		}
	});

	change.remove.forEach(function (name) {
		if (permission.removeFields.indexOf(name) === -1) {
			throw new Error("Removing field is not allowed: " + name);
		}
	});

	var after = schemas.copyJSON(before);

	change.remove.forEach(function (name) {
		delete after[name];
	});

	Object.keys(change.set).forEach(function (name) {
		Object.defineProperty(after, name, {
			value: change.set[name],
			enumerable: true,
			writable: true,
			configurable: true
		});
	});

	return after;
}

exports.validate = validate;
exports.validateList = validateList;
exports.narrow = narrow;
exports.transform = transform;