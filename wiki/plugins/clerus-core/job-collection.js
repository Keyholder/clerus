/*\
title: $:/plugins/clerus/core/job-collection.js
type: application/javascript
module-type: library
\*/

"use strict";

var documentFlow =
	require("$:/plugins/clerus/core/document-flow.js");

/*
These standard forms need no additional destruction protocol once
the job has no active assignments and no unfinished obligations.

Unknown forms may represent external activity or require cleanup.
They prevent collection until their destruction contract is defined.
*/
var PASSIVE_FORMS = [
	"charter",
	"memo",
	"mission",
	"contract",
	"warrant"
];

function barriers(view) {
	var result = [];

	if (!view.retention.complete) {
		result.push("incomplete-retention");
	}

	if (!view.hierarchy.valid || !view.hierarchy.complete) {
		result.push("invalid-or-incomplete-hierarchy");
	}

	if (!view.missions.valid) {
		result.push("invalid-missions");
	}

	return result;
}

function hasUnsupportedDocuments(registry) {
	return Object.keys(registry).some(function (key) {
		var document = registry[key];
		var form;

		try {
			form = documentFlow.formOf(document);
		} catch (error) {
			return true;
		}

		return form !== "job-title" &&
			form !== "tiddler-title" &&
			PASSIVE_FORMS.indexOf(form) === -1;
	});
}

function collect(runtime, options) {
	options = options || {};

	function currentBarriers(view) {
		var result = barriers(view);

		if (options.guard) {
			result = result.concat(options.guard());
		}

		return result;
	}

	var initial = runtime.inspect();
	var blocked = currentBarriers(initial);
	var removed = [];
	var skipped = [];

	if (blocked.length > 0) {
		return {
			removed: removed,
			skipped: skipped,
			blocked: blocked
		};
	}

	/*
	One pass considers only its initial candidates.

	Deleting a superior may release other jobs. Those become candidates
	for a later pass, rather than extending this pass indefinitely.
	*/
	initial.retention.candidates.forEach(function (title) {
		if (blocked.length > 0) {
			return;
		}

		var current = runtime.inspect();
		blocked = currentBarriers(current);

		if (blocked.length > 0) {
			return;
		}

		var job = current.jobs.find(function (candidate) {
			return candidate.title === title;
		});

		if (!job) {
			skipped.push({ title: title, reason: "absent" });
			return;
		}

		if (current.retention.candidates.indexOf(title) === -1) {
			skipped.push({ title: title, reason: "retained" });
			return;
		}

		if (!job.valid) {
			skipped.push({ title: title, reason: "invalid-job" });
			return;
		}

		if (!job.local || !job.owned) {
			skipped.push({ title: title, reason: "not-locally-owned" });
			return;
		}

		var tiddler = runtime.wiki.getTiddler(title);

		if (tiddler.fields["clerus-start"]) {
			skipped.push({
				title: title,
				reason: "unfinished-establishment"
			});
			return;
		}

		if (hasUnsupportedDocuments(job.registry)) {
			skipped.push({
				title: title,
				reason: "unsupported-document-destruction"
			});
			return;
		}

		/*
		This is an explicit lifecycle transition, not an executor action.
		All checks above are synchronous; no executor is invoked between
		the fresh perspective and deletion.
		*/
		runtime.wiki.deleteTiddler(title);
		removed.push(title);
	});

	return {
		removed: removed,
		skipped: skipped,
		blocked: blocked
	};
}

exports.collect = collect;