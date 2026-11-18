/*\
title: $:/plugins/clerus/core/retention.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var hierarchy = require("$:/plugins/clerus/core/hierarchy.js");
var missions = require("$:/plugins/clerus/core/missions.js");
var walEnvelope = require(
	"$:/plugins/clerus/core/wal-envelope.js"
);
var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);
var workPerspective = require(
	"$:/plugins/clerus/core/work-perspective.js"
);

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
);

function evaluate(options) {
	var jobs = schemas.copyJSON(options.jobs);
	var tiddlers = schemas.copyJSON(options.tiddlers);

	if (!Array.isArray(jobs) || !Array.isArray(tiddlers)) {
		throw new Error("Retention requires job and tiddler snapshots");
	}

	var graph = hierarchy.evaluate(jobs);
	var assignments = missions.evaluate(jobs);
	var reasons = new Map();
	var incomplete = [];

	jobs.forEach(function (job) {
		reasons.set(job.title, []);

		try {
			schemas.registry(job.registry, "operational");
		} catch (error) {
			incomplete.push({
				kind: "unsupported-operational-registry",
				title: job.title,
				error: String(error.message)
			});
		}
	});

	function add(title, reason) {
		/*
			Candidacy concerns materialized jobs only.
			Future addresses acquire these grounds when they
			appear in a later perspective.
		*/
		if (reasons.has(title)) {
			reasons.get(title).push(reason);
		}
	}

	function addRegistry(registry, reason) {
		if (!schemas.isRecord(registry)) {
			throw new Error("Invalid retention registry");
		}

		Object.keys(registry).sort().forEach(function (key) {
			var document = registry[key];

			// Reject unknown document semantics conservatively.
			schemas.document(document);

			if (jobTitles.isJobTitle(document)) {
				var detail = schemas.copyJSON(reason);
				detail.key = key;

				add(document, detail);
			}
		});
	}

	assignments.active.forEach(function (assignment) {
		add(assignment.title, {
			kind: "active-mission",
			project: assignment.project,
			role: assignment.role.slice(),
			link: assignment.link
		});
	});

	graph.edges.forEach(function (edge) {
		add(edge.to, {
			kind: "operational-reference",
			source: edge.from,
			keys: edge.keys.slice()
		});
	});

	tiddlers.forEach(function (fields) {
		var platform = walEnvelope.platformOf(fields.title);

		if (platform === null) {
			return;
		}

		try {
			var envelope = walEnvelope.read(fields);

			if (envelope.kind !== "ready") {
				throw new Error(envelope.reason);
			}

			var record = envelope.record;
			var kind = record.kind;

			if (kind === "continuation") {
				var continuation = continuations.validate(
					record,
					platform,
					fields.title
				);

				if (continuation.work !== null) {
					var view = workPerspective.evaluate(
						continuation.work
					);

					view.blocks.forEach(function (title) {
						add(title, {
							kind: "accepted-work",
							wal: fields.title,
							work: view.id
						});
					});

					view.operational.forEach(function (entry) {
						addRegistry(entry.registry, {
							kind: "planned-operational-reference",
							wal: fields.title,
							work: view.id,
							owner: entry.title
						});
					});
				}

				function addEvent(event, id, planned) {
					add(event.recipient.title, {
						kind: planned
							? "planned-event"
							: "waiting-event",
						wal: fields.title,
						event: id
					});

					if (event.kind === "delivery") {
						addRegistry(event.registry, {
							kind: "transactional-reference",
							wal: fields.title,
							event: id
						});
					}
				}

				Object.keys(continuation.events).forEach(
					function (id) {
						addEvent(
							continuation.events[id].event,
							id,
							false
						);
					}
				);

				if (continuation.work !== null) {
					continuation.work.emits.forEach(
						function (effect) {
							if (
								!hasOwn(
									continuation.evidence.identities,
									effect.id
								)
							) {
								addEvent(
									effect.event,
									effect.id,
									true
								);
							}
						}
					);
				}

				return;
			}

			throw new Error("Unsupported WAL kind");
		} catch (error) {
			incomplete.push({
				kind: "unreadable-wal",
				title: fields.title,
				error: String(error && error.message || error)
			});
		}
	});

	var retained = [];
	var unretained = [];

	Array.from(reasons.keys()).sort().forEach(function (title) {
		var grounds = reasons.get(title);

		if (grounds.length > 0) {
			retained.push({
				title: title,
				reasons: grounds
			});
		} else {
			unretained.push(title);
		}
	});

	incomplete.sort(function (left, right) {
		var a = JSON.stringify([left.title, left.kind]);
		var b = JSON.stringify([right.title, right.kind]);

		return a < b ? -1 : a > b ? 1 : 0;
	});

	var complete =
		graph.complete &&
		assignments.complete &&
		incomplete.length === 0;

	return {
		complete: complete,
		valid: graph.valid && assignments.valid,
		retained: retained,
		unretained: unretained,
		candidates: complete ? unretained.slice() : [],
		incomplete: incomplete
	};
}

exports.evaluate = evaluate;