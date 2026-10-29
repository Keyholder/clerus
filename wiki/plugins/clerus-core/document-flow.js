/*\
title: $:/plugins/clerus/core/document-flow.js
type: application/javascript
module-type: library
\*/

"use strict";

var jobViews = require("$:/plugins/clerus/core/job-view.js");
var copyJSON = require("$:/plugins/clerus/core/json.js").copy;
var tiddlerViews =
	require("$:/plugins/clerus/core/tiddler-view.js");

function formOf(document) {
	if (typeof document === "string") {
		if (jobViews.isJobTitle(document)) {
			return "job-title";
		}

		if (tiddlerViews.isOrdinaryTitle(document)) {
			return "tiddler-title";
		}

		throw new Error("Unsupported title document");
	}

	if (
		document !== null &&
		typeof document === "object" &&
		!Array.isArray(document) &&
		typeof document.form === "string"
	) {
		return document.form;
	}

	throw new Error("Invalid document serialization");
}

function loadRules(modules) {
	var rules = new Map();

	modules.forEachModuleOfType("clerus-document", function (title, exports) {
		Object.keys(exports.rules || {}).forEach(function (form) {
			if (rules.has(form)) {
				throw new Error("Duplicate document rules: " + form);
			}

			var rule = exports.rules[form];

			if (
				!rule ||
				["copy", "move", "never"].indexOf(rule.transfer) === -1 ||
				["automatic", "explicit"].indexOf(rule.receipt) === -1 ||
				!Array.isArray(rule.messages) ||
				!rule.messages.every(function (message) {
					return message === "order" || message === "report";
				}) ||
				(
					rule.transform !== undefined &&
					typeof rule.transform !== "function"
				)
			) {
				throw new Error("Invalid document rules: " + title + ":" + form);
			}

			rules.set(form, Object.freeze({
				transfer: rule.transfer,
				receipt: rule.receipt,
				messages: Object.freeze(rule.messages.slice()),
				establishingOnly: !!rule.establishingOnly,
				transform: rule.transform
			}));
		});
	});

	return rules;
}

function prepare(registry, message, rules) {
	var incoming = Object.create(null);
	var automatic = Object.create(null);
	var explicit = Object.create(null);
	var entries = [];
	var contracts = 0;

	Object.keys(registry).forEach(function (key) {
		var document = copyJSON(registry[key]);
		var form = formOf(document);
		var rule = rules.get(form);

		if (!rule) {
			throw new Error("No transmission rules for document form: " + form);
		}

		if (
			rule.transfer === "never" ||
			rule.messages.indexOf(message.type) === -1 ||
			(rule.establishingOnly && !message.establishing)
		) {
			throw new Error("Document cannot be sent in this message: " + form);
		}

		if (form === "contract") {
			contracts++;
		}

		var received = rule.transform
			? copyJSON(rule.transform(document))
			: document;

		// Validate the transformed serialization envelope as well.
		formOf(received);

		incoming[key] = received;

		if (rule.receipt === "automatic") {
			automatic[key] = copyJSON(received);
		} else {
			explicit[key] = copyJSON(received);
		}

		entries.push({
			key: key,
			form: form,
			transfer: rule.transfer,
			receipt: rule.receipt
		});
	});

	if (message.establishing && contracts !== 1) {
		throw new Error("Establishing order must carry exactly one contract");
	}

	return {
		registry: incoming,
		automatic: automatic,
		explicit: explicit,
		entries: entries
	};
}

exports.loadRules = loadRules;
exports.prepare = prepare;
exports.formOf = formOf;