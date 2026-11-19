/*\
title: $:/plugins/clerus/core/warrant-discovery.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var normalize = require("$:/plugins/clerus/core/store.js")
	.transition;

var OPERATORS = new Set([
	"title",
	"prefix",
	"tag",
	"has",
	"field",
	"sort",
	"limit"
]);

var PREFIXES = new Set(["", "+", "-", "~", "="]);

function validateFilter(wiki, filter) {
	if (typeof filter !== "string" || filter.trim().length === 0) {
		throw new Error("Invalid warrant discovery filter");
	}

	var tree;

	try {
		tree = wiki.parseFilter(filter);
	} catch (error) {
		throw new Error(
			"Invalid warrant discovery filter: " + String(error)
		);
	}

	tree.forEach(function (run) {
		if (
			!PREFIXES.has(run.prefix || "") ||
			run.namedPrefix
		) {
			throw new Error(
				"Unsupported warrant filter run prefix"
			);
		}

		run.operators.forEach(function (operator) {
			if (!OPERATORS.has(operator.operator)) {
				throw new Error(
					"Unsupported warrant filter operator: " +
					operator.operator
				);
			}

			if (
				operator.regexp ||
				(
					operator.prefix !== undefined &&
					operator.prefix !== "" &&
					operator.prefix !== "!"
				)
			) {
				throw new Error(
					"Unsupported warrant filter operation"
				);
			}

			if (
				operator.operands.length !== 1 ||
				operator.operands.some(function (operand) {
					return operand.indirect ||
						operand.variable ||
						operand.multiValuedVariable ||
						typeof operand.text !== "string";
				})
			) {
				throw new Error(
					"Warrant filters require one literal operand"
				);
			}

			if (operator.operator === "field") {
				if (
					typeof operator.suffix !== "string" ||
					!/^[A-Za-z0-9_.-]+$/.test(operator.suffix)
				) {
					throw new Error(
						"Warrant field filter requires a field suffix"
					);
				}
			} else if (
				operator.suffix !== undefined ||
				operator.suffixes !== undefined
			) {
				throw new Error(
					"Unsupported warrant filter suffix"
				);
			}
		});
	});
}

function evaluate(snapshot, filters, constructors) {
	var source = schemas.copyJSON(snapshot);

	if (
		!schemas.isRecord(source) ||
		!Array.isArray(source.materialized) ||
		!Array.isArray(filters) ||
		filters.length === 0
	) {
		throw new Error("Invalid warrant discovery input");
	}

	var wiki = new constructors.Wiki({
		enableIndexers: []
	});

	var available = new Set();

	source.materialized.forEach(function (fields) {
		if (!schemas.isRecord(fields)) {
			throw new Error("Invalid warrant discovery snapshot");
		}

		/*
		Normalize trusted store/plan snapshots defensively.
		Do not inspect, render or unpack plugin contents.
		*/
		var normalized = normalize(
			fields.title,
			fields,
			fields
		).after;

		if (!schemas.isOrdinaryTitle(normalized.title)) {
			return;
		}

		if (available.has(normalized.title)) {
			throw new Error(
				"Duplicate warrant discovery title"
			);
		}

		available.add(normalized.title);

		wiki.addTiddler(new constructors.Tiddler(normalized));
	});

	/*
	Validate all filters before evaluating any of them.

	Only literal, built-in-style operations are supported; no
	variable-producing prefixes or variable operands are accepted.
	*/
	filters.forEach(function (filter) {
		validateFilter(wiki, filter);
	});

	/*
	Explicit non-UI environment. Supported operators do not need
	variables; passing a truthy widget avoids the rootWidget fallback.
	*/
	var widget = Object.freeze({
		getVariable: function (name, defaultValue) {
			return defaultValue === undefined ? "" : defaultValue;
		}
	});

	var result = null;

	filters.forEach(function (filter) {
		var found = wiki.filterTiddlers(filter, widget);

		if (
			!Array.isArray(found) ||
			!found.every(function (title) {
				return typeof title === "string";
			})
		) {
			throw new Error("Invalid warrant filter result");
		}

		var seen = new Set();

		var candidates = found.filter(function (title) {
			if (!available.has(title) || seen.has(title)) {
				return false;
			}

			seen.add(title);
			return true;
		});

		if (result === null) {
			result = candidates;
		} else {
			var accepted = new Set(candidates);

			result = result.filter(function (title) {
				return accepted.has(title);
			});
		}
	});

	return result;
}

exports.evaluate = evaluate;