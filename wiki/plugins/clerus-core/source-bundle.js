/*\
title: $:/plugins/clerus/core/source-bundle.js
type: application/javascript
module-type: library
\*/

"use strict";

var snapshots = require("$:/plugins/clerus/core/source-snapshot.js");
var tiddlerViews = require("$:/plugins/clerus/core/tiddler-view.js");

var MAX_SOURCES = 8;
var MAX_CHARACTERS = 60000;

function ordinary(wiki, title) {
	if (
		typeof title !== "string" ||
		!tiddlerViews.isOrdinaryTitle(title) ||
		wiki.isShadowTiddler(title)
	) {
		throw new Error("Sources must be ordinary materialized tiddlers");
	}

	var tiddler = wiki.getTiddler(title);

	if (!tiddler) {
		throw new Error("Source tiddler does not exist: " + title);
	}

	return tiddler;
}

function checkTexts(wiki, entries) {
	if (
		!Array.isArray(entries) ||
		entries.length === 0 ||
		entries.length > MAX_SOURCES
	) {
		throw new Error("A selection must contain between 1 and 8 sources");
	}

	var seen = new Set();
	var total = 0;

	return entries.map(function (entry) {
		if (
			!entry ||
			typeof entry !== "object" ||
			Array.isArray(entry) ||
			typeof entry.label !== "string" ||
			!entry.label.trim()
		) {
			throw new Error("Invalid source entry");
		}

		var tiddler = ordinary(wiki, entry.title);

		if (seen.has(entry.title)) {
			throw new Error("Duplicate source: " + entry.title);
		}

		seen.add(entry.title);

		if (typeof tiddler.fields.text !== "string") {
			throw new Error("Source must contain text: " + entry.title);
		}

		total += tiddler.fields.text.length;

		if (total > MAX_CHARACTERS) {
			throw new Error("Selected sources exceed 60000 text characters");
		}

		return {
			title: entry.title,
			label: entry.label
		};
	});
}

/*
Resolve an ordinary source or an explicitly marked source bundle.
Returned strings are configuration, not capabilities.
The launcher must issue the actual document-title entries.
*/
exports.resolve = function (wiki, title) {
	var tiddler = ordinary(wiki, title);

	if (tiddler.fields["clerus-source-bundle"] !== "yes") {
		return checkTexts(wiki, [{
			title: title,
			label: tiddler.fields["clerus-source-title"] || title
		}]);
	}

	var bundle;

	try {
		bundle = JSON.parse(tiddler.fields.text);
	} catch (error) {
		throw new Error("Invalid source bundle JSON");
	}

	if (
		!bundle ||
		bundle.kind !== "clerus-source-bundle" ||
		bundle.version !== 1
	) {
		throw new Error("Invalid source bundle");
	}

	return checkTexts(wiki, bundle.sources);
};

exports.capture = function (tw, options) {
	var titles = options && options.titles;

	if (
		!Array.isArray(titles) ||
		titles.length === 0 ||
		titles.length > MAX_SOURCES
	) {
		throw new Error("Choose between 1 and 8 system sources");
	}

	var seen = new Set();
	var total = 0;

	/*
	Preflight before creating snapshots.
	capture() repeats its own validation when writing each snapshot.
	*/
	titles.forEach(function (title) {
		if (
			typeof title !== "string" ||
			title.indexOf("$:/") !== 0 ||
			title.indexOf("$:/clerus/jobs/") === 0 ||
			title.indexOf("$:/clerus/wal/") === 0 ||
			title.indexOf("$:/temp/") === 0 ||
			seen.has(title)
		) {
			throw new Error("Invalid or duplicate system source");
		}

		seen.add(title);

		var source = tw.wiki.getTiddler(title);

		if (
			!source ||
			source.fields.type !== "application/javascript" ||
			typeof source.fields.text !== "string"
		) {
			throw new Error("Source must be a JavaScript tiddler: " + title);
		}

		total += source.fields.text.length;

		if (total > MAX_CHARACTERS) {
			throw new Error("Selected sources exceed 60000 text characters");
		}
	});

	var entries = titles.map(function (title) {
		var captured = snapshots.capture(tw, { title: title });

		return {
			title: captured.title,
			label: title
		};
	});

	var target = "Clerus Source Bundles/" +
		Date.now().toString(36) + "-" +
		Math.random().toString(36).slice(2);

	if (tw.wiki.getTiddler(target) || tw.wiki.isShadowTiddler(target)) {
		throw new Error("Bundle title already exists");
	}

	tw.wiki.addTiddler(new tw.Tiddler({
		title: target,
		type: "application/json",
		"clerus-custody": "user",
		"clerus-source-bundle": "yes",
		text: JSON.stringify({
			kind: "clerus-source-bundle",
			version: 1,
			sources: entries
		}, null, 2)
	}));

	return { title: target };
};