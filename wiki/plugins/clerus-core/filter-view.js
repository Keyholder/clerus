/*\
title: $:/plugins/clerus/core/filter-view.js
type: application/javascript
module-type: library
\*/

"use strict";

var tiddlerViews =
	require("$:/plugins/clerus/core/tiddler-view.js");

function isFilter(document) {
	return document !== null &&
		typeof document === "object" &&
		!Array.isArray(document) &&
		document.form === "filter" &&
		typeof document.filter === "string";
}

function titles(wiki, document) {
	if (!isFilter(document)) {
		throw new Error("Invalid filter document");
	}

	var result = wiki.filterTiddlers(document.filter);
	var seen = new Set();

	return result.filter(function (title) {
		if (!tiddlerViews.isOrdinaryTitle(title) || seen.has(title)) {
			return false;
		}

		seen.add(title);
		return true;
	});
}

exports.isFilter = isFilter;
exports.titles = titles;