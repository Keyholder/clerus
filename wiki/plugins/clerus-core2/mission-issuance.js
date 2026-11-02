/*\
title: $:/plugins/clerus/core/mission-issuance.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var roles = require("$:/plugins/clerus/core/roles.js");
var generations = require(
	"$:/plugins/clerus/core/generations.js"
);
var missions = require(
	"$:/plugins/clerus/core/mission-schema.js"
);

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
);

function define(record, key, value) {
	Object.defineProperty(record, key, {
		value: value,
		enumerable: true,
		writable: true,
		configurable: true
	});
}

/*
Recognize possible aliases before validating their complete shape.
A malformed alias must not be silently ignored.
*/
function sameReference(left, right) {
	return schemas.isRecord(left) &&
		left.form === "mission" &&
		left.project === right.project &&
		left.link === right.link &&
		JSON.stringify(left.role) === JSON.stringify(right.role);
}

function open(registry, key) {
	schemas.assertKey(key);

	var result = schemas.copyJSON(registry);

	if (!schemas.isRecord(result)) {
		throw new Error("Registry must be a JSON record");
	}

	if (!hasOwn(result, key)) {
		throw new Error("Unknown mission key: " + key);
	}

	var parent = missions.validate(result[key]);
	var signature = missions.delegationSignature(parent);

	var aliases = Object.keys(result).filter(function (candidateKey) {
		return sameReference(result[candidateKey], parent);
	}).sort();

	aliases.forEach(function (alias) {
		var document;

		try {
			document = missions.validate(result[alias]);
		} catch (error) {
			throw new Error(
				"Mission has a malformed alias: " + alias
			);
		}

		if (
			missions.delegationSignature(document) !== signature
		) {
			throw new Error("Mission has conflicting aliases");
		}
	});

	return {
		registry: result,
		parent: parent,
		aliases: aliases
	};
}

/*
The authoritative counter preserves issuance history.

Current bindings can establish a higher lower bound, but cannot
reconstruct generations whose evidence has already disappeared.
*/
function highWater(parent) {
	var value = parent.issued;

	Object.keys(parent.children).forEach(function (segment) {
		var local = generations.localOrdinal(
			parent.link,
			parent.children[segment]
		);

		if (
			local !== null &&
			generations.compare(local, value) > 0
		) {
			value = local;
		}
	});

	return value;
}

function issue(registry, parentKey, segment, destinationKey) {
	if (!roles.isSegment(segment)) {
		throw new Error("Invalid child role segment");
	}

	schemas.assertKey(destinationKey);

	var work = open(registry, parentKey);

	if (hasOwn(work.registry, destinationKey)) {
		throw new Error(
			"Document key already exists: " + destinationKey
		);
	}

	var ordinal = generations.increment(highWater(work.parent));
	var link = generations.child(work.parent.link, ordinal);

	work.aliases.forEach(function (key) {
		var parent = work.registry[key];

		parent.issued = ordinal;
		define(parent.children, segment, link);
	});

	var document = missions.validate({
		form: "mission",
		project: work.parent.project,
		role: work.parent.role.concat([segment]),
		link: link,
		issued: "0",
		children: {}
	});

	define(work.registry, destinationKey, document);

	return {
		registry: work.registry,
		parentKeys: work.aliases.slice(),
		document: missions.validate(document),
		link: link
	};
}

function revoke(registry, parentKey, segment) {
	if (!roles.isSegment(segment)) {
		throw new Error("Invalid child role segment");
	}

	var work = open(registry, parentKey);

	if (!hasOwn(work.parent.children, segment)) {
		throw new Error("Child binding does not exist");
	}

	var issued = highWater(work.parent);

	work.aliases.forEach(function (key) {
		work.registry[key].issued = issued;
		delete work.registry[key].children[segment];
	});

	return {
		registry: work.registry,
		parentKeys: work.aliases.slice()
	};
}

function drop(registry, key) {
	var work = open(registry, key);

	work.aliases.forEach(function (alias) {
		delete work.registry[alias];
	});

	return {
		registry: work.registry,
		removedKeys: work.aliases.slice()
	};
}

exports.issue = issue;
exports.revoke = revoke;
exports.drop = drop;