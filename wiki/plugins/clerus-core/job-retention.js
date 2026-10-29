/*\
title: $:/plugins/clerus/core/job-retention.js
type: application/javascript
module-type: library
\*/

"use strict";

var hierarchy = require("$:/plugins/clerus/core/hierarchy.js");
var missions = require("$:/plugins/clerus/core/missions.js");
var jobViews = require("$:/plugins/clerus/core/job-view.js");
var messageEffects =
	require("$:/plugins/clerus/core/message-effect.js");
var deferredEffects =
	require("$:/plugins/clerus/core/deferred-effect.js");
var Wal = require("$:/plugins/clerus/core/wal.js").Wal;
var appointmentEffects =
	require("$:/plugins/clerus/core/appointment-effect.js");

function isRecord(value) {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value);
}

function requireKnownFields(record, fields, description) {
	if (
		!isRecord(record) ||
		Object.keys(record).some(function (key) {
			return fields.indexOf(key) === -1;
		})
	) {
		throw new Error("Unsupported fields in " + description);
	}
}

/*
Retention is a derived perspective, not permission to delete.

Operational references, accepted plans, pending official messages,
appointments and deferred events establish retention.

Historical deduplication records and completed branch diagnostics
do not establish retention.

Malformed or unknown WAL records prevent collection candidates
from being reported. Analysis never resumes or modifies a WAL.
*/
function evaluate(wiki, jobs) {
	var reasons = new Map();
	var incomplete = [];
	var graph = hierarchy.audit(jobs);
	var assignments = missions.audit(jobs);

	jobs.forEach(function (job) {
		reasons.set(job.title, []);

		if (!isRecord(job.registry)) {
			incomplete.push({
				kind: "uninspectable-registry",
				title: job.title
			});
		}
	});

	function add(title, reason) {
		if (reasons.has(title)) {
			reasons.get(title).push(reason);
		}
	}

	function addRegistry(registry, walTitle, messageId) {
		if (!isRecord(registry)) {
			throw new Error("Invalid transactional registry");
		}

		Object.keys(registry).sort().forEach(function (key) {
			var document = registry[key];

			if (jobViews.isJobTitle(document)) {
				add(document, {
					kind: "transactional-reference",
					wal: walTitle,
					message: messageId,
					key: key
				});
			}
		});
	}

	function addMessage(message, walTitle, platform) {
		messageEffects.validate(message);

		if (message.recipient.platform !== platform) {
			throw new Error("Foreign pending recipient");
		}

		add(message.recipient.title, {
			kind: "pending-message",
			wal: walTitle,
			message: message.id
		});

		addRegistry(message.registry, walTitle, message.id);
	}

	function addPlannedRegistry(registry, walTitle, owner, kind) {
		if (!isRecord(registry)) {
			throw new Error("Invalid planned registry");
		}

		Object.keys(registry).sort().forEach(function (key) {
			var document = registry[key];

			if (typeof document !== "string" && !isRecord(document)) {
				throw new Error("Invalid planned document");
			}

			if (jobViews.isJobTitle(document)) {
				add(document, {
					kind: kind,
					wal: walTitle,
					owner: owner,
					key: key
				});
			}
		});
	}

	function addActive(active, walTitle, platform, flow, seen) {
		if (
			!isRecord(active) ||
			!isRecord(active.owner) ||
			!isRecord(active.plan)
		) {
			throw new Error("Invalid accepted plan");
		}

		requireKnownFields(
			active,
			["owner", "plan"],
			"accepted materialization"
		);

		requireKnownFields(
			active.owner,
			["title", "executor", "state"],
			"accepted owner"
		);

		requireKnownFields(
			active.plan,
			["version", "effects", "messages", "deferred", "appointments"],
			"accepted plan"
		);

		var owner = active.owner;
		var plan = active.plan;
		var guard = new Wal({
			wiki: wiki,
			platform: platform
		});

		if (
			plan.version !== 1 ||
			!Array.isArray(plan.effects) ||
			(flow && !Array.isArray(plan.messages))
		) {
			throw new Error("Invalid accepted plan envelope");
		}

		/*
		Validate serialization, not present-day authorization or
		materialization preconditions. A conflicting or paused plan
		still establishes retention.
		*/
		if (flow) {
			var validationEffects = plan.effects.slice();

			// Ordinary WAL validation requires at least one state effect.
			// A message-only flow still has an authoritative owner baseline.
			if (validationEffects.length === 0) {
				validationEffects.push({
					version: 1,
					kind: "tiddler-put",
					title: owner.title,
					before: owner.state,
					after: owner.state
				});
			}

			guard.validate({
				version: 1,
				platform: platform,
				owner: owner,
				plan: {
					version: 1,
					effects: validationEffects,
					messages: []
				}
			});
		} else {
			guard.validate({
				version: 1,
				platform: platform,
				owner: owner,
				plan: plan
			});
		}

		add(owner.title, {
			kind: "accepted-plan-owner",
			wal: walTitle
		});

		var ownerEffect = plan.effects.find(function (effect) {
			return effect.title === owner.title;
		});

		var finalState = ownerEffect
			? ownerEffect.after
			: owner.state;

		addPlannedRegistry(
			JSON.parse(finalState.text),
			walTitle,
			owner.title,
			"planned-operational-reference"
		);

		if (!flow) {
			return;
		}

		if (
			(plan.deferred !== undefined && !Array.isArray(plan.deferred)) ||
			(
				plan.appointments !== undefined &&
				!Array.isArray(plan.appointments)
			)
		) {
			throw new Error("Invalid accepted flow effects");
		}

		var messageIds = new Set();

		function claimMessage(message) {
			if (messageIds.has(message.id)) {
				throw new Error("Repeated planned message identity");
			}

			messageIds.add(message.id);

			if (
				Object.prototype.hasOwnProperty.call(seen, message.id) &&
				JSON.stringify(seen[message.id]) !== JSON.stringify(message)
			) {
				throw new Error("Flow message identity was reused");
			}
		}

		plan.messages.forEach(function (message) {
			messageEffects.validate(message);

			if (
				message.source.title !== owner.title ||
				message.source.executor !== owner.executor ||
				message.source.platform !== platform ||
				message.recipient.platform !== platform
			) {
				throw new Error("Invalid planned message origin or identity");
			}

			claimMessage(message);
			addMessage(message, walTitle, platform);
		});

		(plan.deferred || []).forEach(function (effect) {
			deferredEffects.validate(effect);

			if (
				effect.recipient.title !== owner.title ||
				effect.recipient.executor !== owner.executor ||
				effect.recipient.platform !== platform
			) {
				throw new Error("Invalid planned deferred recipient");
			}

			add(effect.recipient.title, {
				kind: "planned-deferred-event",
				wal: walTitle,
				event: effect.id
			});
		});

		var appointed = new Set();

		(plan.appointments || []).forEach(function (effect) {
			appointmentEffects.validate(effect);

			if (
				effect.source.title !== owner.title ||
				effect.source.executor !== owner.executor ||
				effect.source.platform !== platform ||
				effect.recipient.platform !== platform ||
				appointed.has(effect.recipient.title)
			) {
				throw new Error("Invalid planned appointment origin or target");
			}

			appointed.add(effect.recipient.title);
			claimMessage(appointmentEffects.message(effect));

			add(effect.recipient.title, {
				kind: "accepted-appointment",
				wal: walTitle,
				appointment: effect.id
			});

			addPlannedRegistry(
				effect.registry,
				walTitle,
				effect.recipient.title,
				"appointment-reference"
			);
		});
	}

	function inspectWal(tiddler, title, platform) {
		var record = JSON.parse(tiddler.fields.text);
		var kind = tiddler.fields["clerus-wal-kind"];

		if (
			tiddler.fields.type !== "application/json" ||
			!isRecord(record) ||
			record.version !== 1 ||
			record.platform !== platform
		) {
			throw new Error("Invalid WAL envelope");
		}

		if (kind === "deferred") {
			requireKnownFields(
				record,
				["version", "kind", "platform", "effect"],
				"deferred WAL"
			);

			if (record.kind !== "deferred") {
				throw new Error("Invalid deferred envelope");
			}

			deferredEffects.validate(record.effect);

			var effect = record.effect;

			if (
				effect.recipient.platform !== platform ||
				title !== "$:/clerus/wal/" + platform +
					"/deferred-" + effect.id ||
				tiddler.fields["clerus-deferred-effect"] !==
					JSON.stringify(effect)
			) {
				throw new Error("Deferred WAL identity mismatch");
			}

			add(effect.recipient.title, {
				kind: "deferred-event",
				wal: title,
				event: effect.id
			});

			return;
		}

		if (kind === "flow") {
			requireKnownFields(
				record,
				[
					"version", "kind", "platform",
					"active", "pending", "seen", "errors"
				],
				"flow WAL"
			);

			if (
				record.kind !== "flow" ||
				!Array.isArray(record.pending) ||
				!isRecord(record.seen) ||
				!Array.isArray(record.errors) ||
				(record.active !== null && !isRecord(record.active))
			) {
				throw new Error("Invalid flow envelope");
			}

			var pendingIds = new Set();

			record.pending.forEach(function (message) {
				addMessage(message, title, platform);

				if (
					pendingIds.has(message.id) ||
					!Object.prototype.hasOwnProperty.call(
						record.seen, message.id
					) ||
					JSON.stringify(record.seen[message.id]) !==
						JSON.stringify(message)
				) {
					throw new Error("Invalid pending message identity");
				}

				pendingIds.add(message.id);
			});

			if (record.active !== null) {
				addActive(
					record.active,
					title,
					platform,
					true,
					record.seen
				);
			}

			// seen and errors are historical, not pending registries.
			return;
		}

		if (kind !== undefined) {
			throw new Error("Unknown WAL kind");
		}

		requireKnownFields(
			record,
			["version", "platform", "owner", "plan", "incident"],
			"work-plan or incident WAL"
		);

		if (
			record.plan !== undefined &&
			record.incident !== undefined
		) {
			throw new Error("Ambiguous WAL body");
		}

		if (record.plan !== undefined) {
			addActive({
				owner: record.owner,
				plan: record.plan
			}, title, platform, false);

			return;
		}

		if (!isRecord(record.incident) || !isRecord(record.owner)) {
			throw new Error("Unknown WAL body");
		}

		// A recorded incident is not an unfinished materialization.
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

	/*
	Inspect both platforms' WAL spaces, regardless of custody.
	A foreign or paused obligation is still authoritative information.

	This only reads records. It neither authorizes recovery nor changes
	custody, diagnostics or delivery state.
	*/
	wiki.each(function (tiddler, title) {
		var platform;

		if (title.indexOf("$:/clerus/wal/browser/") === 0) {
			platform = "browser";
		} else if (title.indexOf("$:/clerus/wal/node/") === 0) {
			platform = "node";
		} else {
			return;
		}

		try {
			inspectWal(tiddler, title, platform);
		} catch (error) {
			incomplete.push({
				kind: "unreadable-wal",
				title: title,
				error: String(error && error.message || error)
			});
		}
	});

	incomplete.sort(function (left, right) {
		var a = JSON.stringify([left.title, left.kind]);
		var b = JSON.stringify([right.title, right.kind]);

		return a < b ? -1 : a > b ? 1 : 0;
	});

	var complete = incomplete.length === 0;
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

	return {
		complete: complete,
		retained: retained,

		// No grounds were found in the interpreted facts.
		// Under incomplete analysis this is not proof of collectability.
		unretained: unretained,

		// These lack retention grounds under a complete analysis.
		// Custody, validity and deletion preconditions are separate.
		candidates: complete ? unretained.slice() : [],

		incomplete: incomplete
	};
}

exports.evaluate = evaluate;