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
var acceptedPlans = require(
	"$:/plugins/clerus/core/accepted-plan-schema.js"
);
var flowSchema = require("$:/plugins/clerus/core/flow-schema.js");
var deferredSchema = require(
	"$:/plugins/clerus/core/deferred-schema.js"
);
var incidentSchema = require(
	"$:/plugins/clerus/core/incident-schema.js"
);
var walEnvelope = require(
	"$:/plugins/clerus/core/wal-envelope.js"
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

	function addMessage(message, wal) {
		add(message.recipient.title, {
			kind: message.establishing
				? "pending-establishment"
				: "pending-message",
			wal: wal,
			message: message.id
		});

		addRegistry(message.registry, {
			kind: "transactional-reference",
			wal: wal,
			message: message.id
		});
	}

	function addActive(proposal, wal, platform) {
		/*
			Validate accepted authority, not current authorization
			or current before/after preconditions.
		*/
		acceptedPlans.validate({
			version: 1,
			kind: "plan",
			platform: platform,

			proposal: {
				version: 1,
				owner: proposal.owner,
				plan: {
					version: 1,
					effects: proposal.plan.effects
				}
			}
		}, platform, true);

		add(proposal.owner.title, {
			kind: proposal.owner.state === null
				? "accepted-birth"
				: "accepted-plan-owner",
			wal: wal
		});

		var effect = proposal.plan.effects.find(function (candidate) {
			return candidate.title === proposal.owner.title;
		});

		var finalState = effect
			? effect.after
			: proposal.owner.state;

		if (finalState === null) {
			throw new Error("Accepted owner has no final state");
		}

		addRegistry(JSON.parse(finalState.text), {
			kind: "planned-operational-reference",
			wal: wal,
			owner: proposal.owner.title
		});

		(proposal.plan.deferred || []).forEach(function (event) {
			add(event.recipient.title, {
				kind: "planned-deferred-event",
				wal: wal,
				event: event.id
			});
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

			if (kind === "incident") {
				incidentSchema.validate(record, platform);

				// Valid diagnostic history is not unfinished materialization.
				return;
			}

			if (kind === "plan") {
				var accepted = acceptedPlans.validate(record, platform);

				addActive(
					accepted.proposal,
					fields.title,
					platform
				);

				return;
			}

			if (kind === "deferred") {
				var waiting = deferredSchema.validate(record, platform);

				if (
					fields.title !==
						"$:/clerus/wal/" + platform +
						"/deferred-" + waiting.effect.id ||
					fields["clerus-deferred-effect"] !==
						JSON.stringify(waiting.effect)
				) {
					throw new Error("Deferred identity mismatch");
				}

				add(waiting.effect.recipient.title, {
					kind: "deferred-event",
					wal: fields.title,
					event: waiting.effect.id
				});

				return;
			}

			if (kind === "flow") {
				var flow = flowSchema.validate(record, platform);

				flow.pending.forEach(function (message) {
					addMessage(message, fields.title);
				});

				if (flow.active !== null) {
					addActive(
						flow.active,
						fields.title,
						platform
					);

					flow.active.plan.messages.forEach(function (message) {
						/*
							Already registered identities are covered
							by pending, or are completed history.
						*/
						if (!hasOwn(flow.seen, message.id)) {
							addMessage(message, fields.title);
						}
					});
				}

				// seen and errors do not establish retention.
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