/*\
title: $:/plugins/clerus/core2/scope.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var documents = require("$:/plugins/clerus/core2/documents.js");

function validateTiddlerView(value, title) {
	var view = schemas.copyJSON(value);

	if (
		!schemas.isRecord(view) ||
		(
			view.kind !== "absent" &&
			view.kind !== "materialized" &&
			view.kind !== "shadow"
		)
	) {
		throw new Error("Invalid tiddler view");
	}

	if (view.kind === "absent") {
		if (view.fields !== null) {
			throw new Error("Absent tiddler must have null fields");
		}

		return view;
	}

	if (
		!schemas.isRecord(view.fields) ||
		view.fields.title !== title ||
		!Object.keys(view.fields).every(function (key) {
			return typeof view.fields[key] === "string";
		})
	) {
		throw new Error("Invalid tiddler fields");
	}

	return view;
}

function open(options) {
	options = options || {};

	/*
	Validate all initial registries before constructing the scope.
	No externally visible effects happen during construction.
	*/
	var operational = schemas.registry(
		options.operational,
		"operational"
	);

	var incoming = options.incoming === undefined
		? null
		: schemas.registry(options.incoming, "incoming");

	if (
		options.readTiddler !== undefined &&
		typeof options.readTiddler !== "function"
	) {
		throw new Error("readTiddler must be a function");
	}

	var active = true;
	var registries = new Map();
	var titleNodes = new Map();
	var nodes = new Set();

	function assertActive() {
		if (!active) {
			throw new Error("Clerus scope is closed");
		}
	}

	function assertPresent(node) {
		assertActive();

		if (node.references === 0) {
			throw new Error("Document is no longer available");
		}
	}

	function newNode(form, value) {
		var node = {
			form: form,
			value: value,
			references: 0,
			instance: null
		};

		nodes.add(node);

		return node;
	}

	function nodeFor(value) {
		var form = schemas.formOf(value);

		if (form === "tiddler-title") {
			if (!titleNodes.has(value)) {
				titleNodes.set(
					value,
					newNode(form, value)
				);
			}

			return titleNodes.get(value);
		}

		/*
		Equal JSON content does not merge separate memo entries.
		*/
		return newNode(form, value);
	}

	function instanceFor(node) {
		assertPresent(node);

		if (node.instance) {
			return node.instance;
		}

		var access = Object.freeze({
			read: function () {
				assertPresent(node);
				return schemas.copyJSON(node.value);
			},

			inspectTiddler: function () {
				assertPresent(node);

				if (node.form !== "tiddler-title") {
					throw new Error("Document is not a tiddler title");
				}

				if (typeof options.readTiddler !== "function") {
					throw new Error("Tiddler reading is unavailable");
				}

				return validateTiddlerView(
					options.readTiddler(node.value),
					node.value
				);
			}
		});

		node.instance = documents.create(node.form, access);

		return node.instance;
	}

	function addRegistry(id, kind, serialized) {
		var entries = new Map();

		Object.keys(serialized).forEach(function (key) {
			var node = nodeFor(serialized[key]);

			node.references++;

			entries.set(key, {
				node: node
			});
		});

		var view = Object.freeze({
			keys: function () {
				assertActive();
				return Array.from(entries.keys());
			},

			get: function (key) {
				assertActive();
				schemas.assertKey(key);

				var entry = entries.get(key);

				if (!entry) {
					throw new Error("Unknown document key: " + key);
				}

				return instanceFor(entry.node);
			}
		});

		registries.set(id, {
			kind: kind,
			entries: entries,
			view: view
		});

		return view;
	}

	var operationalView = addRegistry(
		"operational",
		"operational",
		operational
	);

	var incomingView = incoming === null
		? null
		: addRegistry("incoming", "incoming", incoming);

	return Object.freeze({
		operational: operationalView,
		incoming: incomingView,

		close: function () {
			if (!active) {
				return;
			}

			active = false;

			registries.forEach(function (registry) {
				registry.entries.clear();
			});

			nodes.forEach(function (node) {
				node.references = 0;
				node.value = null;
				node.instance = null;
			});

			registries.clear();
			titleNodes.clear();
			nodes.clear();
		}
	});
}

exports.open = open;