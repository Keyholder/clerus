/*\
title: $:/plugins/clerus/core/mission-issuance.js
type: application/javascript
module-type: library
\*/

"use strict";

var copyJSON = require("$:/plugins/clerus/core/json.js").copy;
var roles = require("$:/plugins/clerus/core/roles.js");
var labels = require("$:/plugins/clerus/core/mission-labels.js");
var links = require("$:/plugins/clerus/core/mission-links.js");

function sameIdentity(left, right) {
	return left &&
		left.form === "mission" &&
		left.project === right.project &&
		left.link === right.link &&
		JSON.stringify(left.role) === JSON.stringify(right.role);
}

function signature(document) {
	return JSON.stringify([
		document.issued,
		Object.keys(document.children).sort().map(function (key) {
			return [key, document.children[key]];
		})
	]);
}

function open(registry, parentKey) {
	if (
		!registry ||
		typeof registry !== "object" ||
		Array.isArray(registry)
	) {
		throw new Error("Registry must be an object");
	}

	var result = copyJSON(registry);
	var parent = result[parentKey];

	if (
		!Object.prototype.hasOwnProperty.call(result, parentKey) ||
		!links.isMission(parent)
	) {
		throw new Error("Parent document is not a linked mission");
	}

	var expected = signature(parent);
	var aliases = Object.keys(result).filter(function (key) {
		return sameIdentity(result[key], parent);
	});

	aliases.forEach(function (key) {
		if (
			!links.isMission(result[key]) ||
			signature(result[key]) !== expected
		) {
			throw new Error("Parent mission has conflicting aliases");
		}
	});

	return {
		registry: result,
		parent: parent,
		aliases: aliases
	};
}

function highWater(parent) {
	var value = parent.issued;
	var prefix = parent.link + "/";

	// Accommodate manually prepared documents that omit issued,
	// but already contain bindings from this issuance namespace.
	Object.keys(parent.children).forEach(function (segment) {
		var link = parent.children[segment];

		if (link.indexOf(prefix) !== 0) {
			return;
		}

		var suffix = link.slice(prefix.length);

		if (labels.isOrdinal(suffix) && labels.compare(suffix, value) > 0) {
			value = suffix;
		}
	});

	return value;
}

function issue(registry, parentKey, segment, destinationKey) {
	if (!roles.isSegment(segment)) {
		throw new Error("Invalid child role segment");
	}

	if (typeof destinationKey !== "string" || destinationKey.length === 0) {
		throw new Error("Destination key must be non-empty");
	}

	var work = open(registry, parentKey);

	if (
		Object.prototype.hasOwnProperty.call(
			work.registry, destinationKey
		)
	) {
		throw new Error("Destination key is occupied");
	}

	var next = labels.increment(highWater(work.parent));
	var link = work.parent.link + "/" + next;

	work.aliases.forEach(function (key) {
		var parent = work.registry[key];

		parent.issued = next;

		Object.defineProperty(parent.children, segment, {
			value: link,
			enumerable: true,
			writable: true,
			configurable: true
		});
	});

	var document = {
		form: "mission",
		project: work.parent.project,
		role: work.parent.role.concat([segment]),
		link: link,
		issued: "0",
		children: {}
	};

	Object.defineProperty(work.registry, destinationKey, {
		value: document,
		enumerable: true,
		writable: true,
		configurable: true
	});

	return {
		registry: work.registry,
		parentKeys: work.aliases,
		document: copyJSON(document),
		link: link
	};
}

function revoke(registry, parentKey, segment) {
	if (!roles.isSegment(segment)) {
		throw new Error("Invalid child role segment");
	}

	var work = open(registry, parentKey);

	if (
		!Object.prototype.hasOwnProperty.call(
			work.parent.children, segment
		)
	) {
		throw new Error("Child binding does not exist");
	}

	var issued = highWater(work.parent);

	work.aliases.forEach(function (key) {
		var parent = work.registry[key];

		parent.issued = issued;
		delete parent.children[segment];
	});

	return {
		registry: work.registry,
		parentKeys: work.aliases
	};
}

exports.issue = issue;
exports.revoke = revoke;

function drop(registry, key) {
	var work = open(registry, key);

	work.aliases.forEach(function (alias) {
		delete work.registry[alias];
	});

	return {
		registry: work.registry,
		removedKeys: work.aliases
	};
}

exports.drop = drop;