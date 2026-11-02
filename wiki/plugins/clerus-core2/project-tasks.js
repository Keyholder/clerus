/*\
title: $:/plugins/clerus/core/project-tasks.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var roles = require("$:/plugins/clerus/core/roles.js");

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
);

function resolve(tree, role) {
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
			return schemas.copyJSON(node.task);
		}

		if (!hasOwn(node.parts, path[index])) {
			throw new Error("Task does not exist");
		}

		node = node.parts[path[index]];
	}
}

exports.resolve = resolve;