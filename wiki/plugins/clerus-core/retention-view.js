/*\
title: $:/plugins/clerus/core/retention-view.js
type: application/javascript
module-type: library
\*/

"use strict";

var Store = require("$:/plugins/clerus/core/store.js").Store;
var jobState = require("$:/plugins/clerus/core/job-state.js");
var retention = require("$:/plugins/clerus/core/retention.js");
var localCustody = require("$:/plugins/clerus/core/local-custody.js");

exports.read = function (options) {
	var store = new Store({
		wiki: options.wiki,
		Tiddler: options.Tiddler
	});

	var snapshot = store.snapshot();

	var jobs = jobState.readJobs(function (visit) {
		snapshot.materialized.forEach(function (fields) {
			visit(fields, fields.title);
		});
	});

	var analysis = retention.evaluate({
		jobs: jobs,
		tiddlers: snapshot.materialized
	});

	var custody = localCustody.create({
		store: store,
		platform: options.platform
	});

	var reasons = new Map();

	analysis.retained.forEach(function (entry) {
		reasons.set(entry.title, entry.reasons);
	});

	var fieldsByTitle = new Map();

	snapshot.materialized.forEach(function (fields) {
		fieldsByTitle.set(fields.title, fields);
	});

	return {
		platform: options.platform,
		complete: analysis.complete,
		valid: analysis.valid,
		incomplete: analysis.incomplete,
		jobs: jobs.map(function (job) {
			var fields = fieldsByTitle.get(job.title);

			return {
				title: job.title,
				custody: job.custody,
				locallyOwned: custody.owns(fields),
				reasons: reasons.get(job.title) || [],
				analysisCandidate:
					analysis.candidates.indexOf(job.title) !== -1
			};
		}).sort(function (left, right) {
			return left.title < right.title ? -1
				: left.title > right.title ? 1 : 0;
		})
	};
};