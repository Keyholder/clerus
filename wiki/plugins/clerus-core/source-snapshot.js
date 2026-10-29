/*\
title: $:/plugins/clerus/core/source-snapshot.js
type: application/javascript
module-type: library
\*/

"use strict";

exports.capture = function (tw, options) {
	options = options || {};

	var wiki = tw.wiki;
	var title = options.title;

	if (
		typeof title !== "string" ||
		title.indexOf("$:/") !== 0
	) {
		throw new Error("Choose a system JavaScript tiddler");
	}

	if (
		title.indexOf("$:/clerus/jobs/") === 0 ||
		title.indexOf("$:/clerus/wal/") === 0 ||
		title.indexOf("$:/temp/") === 0
	) {
		throw new Error("Runtime state cannot be captured by this adapter");
	}

	var source = wiki.getTiddler(title);

	if (!source) {
		throw new Error("Source tiddler does not exist");
	}

	if (
		source.fields.type !== "application/javascript" ||
		typeof source.fields.text !== "string"
	) {
		throw new Error("Source must be a JavaScript tiddler");
	}

	if (source.fields.text.length > 60000) {
		throw new Error("Source exceeds 60000 text characters");
	}

	var shadow = wiki.isShadowTiddler(title);
	var materialized = wiki.tiddlerExists(title);

	var origin = shadow
		? materialized ? "shadow-override" : "shadow"
		: "system";

	var id = Date.now().toString(36) + "-" +
		Math.random().toString(36).slice(2);

	var target = "Clerus Sources/" + id;

	if (wiki.getTiddler(target) || wiki.isShadowTiddler(target)) {
		throw new Error("Snapshot title already exists");
	}

	var fields = {
		title: target,
		type: "text/plain",
		"clerus-custody": "user",
		"clerus-source-title": title,
		"clerus-source-origin": origin,
		"clerus-source-captured": new Date().toISOString(),
		text: source.fields.text
	};

	if (typeof source.fields["module-type"] === "string") {
		fields["clerus-source-module-type"] =
			source.fields["module-type"];
	}

	wiki.addTiddler(new tw.Tiddler(fields));

	return {
		title: target,
		source: title,
		origin: origin
	};
};