/*\
title: $:/plugins/clerus/core/registry-writer.js
type: application/javascript
module-type: library
\*/

"use strict";

var effects = require("$:/plugins/clerus/core/effects.js");
var copyJSON = require("$:/plugins/clerus/core/json.js").copy;

function createWriter(options) {
	var state = options.state;
	var job = options.job;
	var platform = options.platform;
	var Tiddler = options.Tiddler;
	var initial = state.getTiddler(job.title);
	var expectedText = initial && initial.fields.text;

	function current() {
		if (job.persistent && state.mode !== "planned") {
			throw new Error("Persistent writes require a work plan");
		}

		var prefix = job.persistent
			? "$:/clerus/jobs/"
			: "$:/temp/clerus/jobs/" + platform + "/";

		var tiddler = state.getTiddler(job.title);

		if (
			job.title.indexOf(prefix) !== 0 ||
			!tiddler ||
			tiddler.fields["clerus-custody"] !== platform ||
			tiddler.fields["clerus-executor"] !== job.executor ||
			tiddler.fields.type !== "application/json" ||
			tiddler.fields.text !== expectedText
		) {
			throw new Error("Operational registry write precondition failed");
		}

		return tiddler;
	}

	function commit(registry) {
		var next = copyJSON(registry);

		if (
			!next ||
			typeof next !== "object" ||
			Array.isArray(next)
		) {
			throw new Error("Registry must be an object");
		}

		var before = current();
		var text = JSON.stringify(next);

		state.apply(effects.put(
			before,
			new Tiddler(before, { text: text })
		));

		expectedText = text;
	}

	function replace(key, document, operation) {
		operation = operation || {};

		var registry = JSON.parse(current().fields.text);
		var exists = Object.prototype.hasOwnProperty.call(registry, key);

		if (operation.insert ? exists : !exists) {
			throw new Error("Document key precondition failed: " + key);
		}

		if (operation.insert && document === undefined) {
			throw new Error("Cannot insert an undefined document");
		}

		var removeKeys = operation.removeKeys || [];

		if (
			!Array.isArray(removeKeys) ||
			!removeKeys.every(function (removedKey) {
				return typeof removedKey === "string" &&
					Object.prototype.hasOwnProperty.call(registry, removedKey);
			})
		) {
			throw new Error("Additional removal precondition failed");
		}

		if (document === undefined) {
			delete registry[key];
		} else {
			Object.defineProperty(registry, key, {
				value: document,
				enumerable: true,
				writable: true,
				configurable: true
			});
		}

		removeKeys.forEach(function (removedKey) {
			delete registry[removedKey];
		});

		commit(registry);
	}

	replace.replaceAll = commit;

	return replace;
}

exports.createWriter = createWriter;