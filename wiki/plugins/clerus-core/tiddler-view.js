/*\
title: $:/plugins/clerus/core/tiddler-view.js
type: application/javascript
module-type: library
\*/

"use strict";

function isOrdinaryTitle(title) {
	return typeof title === "string" &&
		title.length > 0 &&
		title.indexOf("$:/") !== 0;
}

function read(wiki, title) {
	var tiddler = wiki.getTiddler(title);

	if (!tiddler) {
		return {
			exists: false,
			fields: null
		};
	}

	var fields = Object.create(null);

	// Canonical field order makes observation independent of insertion order.
	Object.keys(tiddler.fields).sort().forEach(function (name) {
		fields[name] = tiddler.getFieldString(name);
	});

	return {
		exists: true,
		fields: fields
	};
}

exports.isOrdinaryTitle = isOrdinaryTitle;
exports.read = read;