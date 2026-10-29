/*\
title: $:/plugins/clerus/core/filter-writer.js
type: application/javascript
module-type: library
\*/

"use strict";

var filterViews =
	require("$:/plugins/clerus/core/filter-view.js");
var tiddlerViews =
	require("$:/plugins/clerus/core/tiddler-view.js");

function issueTitle(options) {
	var runtime = options.runtime;
	var source = options.job;

	if (source.persistent) {
		throw new Error("Persistent title issuance requires a work plan");
	}

	if (!tiddlerViews.isOrdinaryTitle(options.title)) {
		throw new Error("Only ordinary tiddler titles can be issued");
	}

	if (
		typeof options.destinationKey !== "string" ||
		options.destinationKey.length === 0
	) {
		throw new Error("Destination key must be non-empty");
	}

	var current = runtime.inspect().jobs.find(function (job) {
		return job.title === source.title;
	});

	if (
		!current ||
		!current.valid ||
		!current.local ||
		!current.owned ||
		current.executor !== source.executor
	) {
		throw new Error("Job no longer has authority to receive a title");
	}

	if (
		JSON.stringify(current.registry[options.key]) !==
		JSON.stringify(options.document)
	) {
		throw new Error("Filter document has changed outside this context");
	}

	if (
		Object.prototype.hasOwnProperty.call(
			current.registry, options.destinationKey
		)
	) {
		throw new Error("Document key already exists");
	}

	var allowed = filterViews.titles(
		runtime.wiki,
		current.registry[options.key]
	);

	if (allowed.indexOf(options.title) === -1) {
		throw new Error("Title is not in the current filter result");
	}

	options.replace(options.destinationKey, options.title, {
		insert: true
	});
}

exports.issueTitle = issueTitle;