/*\
title: $:/plugins/clerus/core/project-tasks.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var roles = require("$:/plugins/clerus/core/roles.js");

var hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);

function nodeAt(tree, role) {
	var path = roles.assertRole(role);
	var node = tree;

	for (var index = 0; index <= path.length; index++) {
		if (
			!schemas.isRecord(node) ||
			!hasOwn(node, "task") ||
			!schemas.isRecord(node.parts)
		) {
			throw new Error("Invalid task node");
		}

		if (index === path.length) {
			return node;
		}

		if (!hasOwn(node.parts, path[index])) {
			throw new Error("Task does not exist");
		}

		node = node.parts[path[index]];
	}
}

function resolve(tree, role) {
	return schemas.copyJSON(nodeAt(tree, role).task);
}

function parts(tree, role) {
	var names = Object.keys(nodeAt(tree, role).parts).sort();

	names.forEach(function (segment) {
		if (!roles.isSegment(segment)) {
			throw new Error("Invalid child role segment");
		}
	});

	return names;
}

function change(tree, role, operation, segment, task) {
	if (!roles.isSegment(segment)) {
		throw new Error("Invalid child role segment");
	}

	if (operation !== "create" && operation !== "set-task") {
		throw new Error("Unsupported task mutation");
	}

	var result = schemas.copyJSON(tree);
	var parent = nodeAt(result, role);
	var exists = hasOwn(parent.parts, segment);

	if (operation === "create") {
		if (exists) {
			throw new Error("Task already exists");
		}

		Object.defineProperty(parent.parts, segment, {
			value: {
				task: schemas.copyJSON(task),
				parts: {}
			},
			enumerable: true,
			writable: true,
			configurable: true
		});
	} else {
		if (!exists) {
			throw new Error("Task does not exist");
		}

		var child = nodeAt(result, role.concat([segment]));
		child.task = schemas.copyJSON(task);
	}

	return result;
}

exports.resolve = resolve;
exports.parts = parts;
exports.change = change;