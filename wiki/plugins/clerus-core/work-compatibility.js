/*\
title: $:/plugins/clerus/core/work-compatibility.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var proposals = require(
	"$:/plugins/clerus/core/proposal-schema.js"
);
var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);
var workPerspective = require(
	"$:/plugins/clerus/core/work-perspective.js"
);
var envelopes = require(
	"$:/plugins/clerus/core/wal-envelope.js"
);
var barriers = require(
	"$:/plugins/clerus/core/materialization-barrier.js"
);
var reservations = require(
	"$:/plugins/clerus/core/establishment-reservations.js"
);

function proposalView(value) {
	var proposal = proposals.validate(value, {
		allowMessages: true,
		allowDeferred: true
	});

	var writes = proposal.plan.effects.map(function (effect) {
		return effect.title;
	}).sort();

	return {
		id: null,
		writes: writes,
		reads: writes.indexOf(proposal.owner.title) === -1
			? [proposal.owner.title]
			: [],
		blocks: [proposal.owner.title]
	};
}

function workView(value) {
	var view = workPerspective.evaluate(value);

	return {
		id: view.id,
		writes: view.writes,
		reads: view.reads,
		blocks: view.blocks
	};
}

function intersects(left, right) {
	var values = new Set(left);

	return right.some(function (value) {
		return values.has(value);
	});
}

function conflicts(a, b) {
	return (
		intersects(a.writes, b.writes) ||
		intersects(a.writes, b.reads) ||
		intersects(a.reads, b.writes) ||
		intersects(a.blocks, b.blocks)
	);
}

/*
Check compatibility with all visible accepted material work.

options.title identifies the journal being resumed/replaced,
not a title to acquire or a proof of execution authority.

Exactly one of options.work/options.proposal must be supplied.
*/
function check(options) {
	if (
		!options.store ||
		typeof options.store.snapshot !== "function"
	) {
		throw new Error("Work compatibility requires a snapshot store");
	}

	var hasWork = options.work !== undefined;
	var hasProposal = options.proposal !== undefined;

	if (hasWork === hasProposal) {
		throw new Error(
			"Compatibility requires one work or proposal"
		);
	}

	if (
		options.title !== undefined &&
		envelopes.platformOf(options.title) === null
	) {
		throw new Error("Invalid compatibility journal address");
	}

	var candidate = hasWork
		? workView(options.work)
		: proposalView(options.proposal);

	var knowledge = barriers.collect({
		store: options.store
	}).inspect();

	if (!knowledge.complete) {
		throw new Error(
			"Cannot establish work compatibility: unreadable WAL"
		);
	}

	reservations.check({
		store: options.store,
		title: options.title,
		claims: hasWork
			? reservations.fromWork(options.work)
			: reservations.fromProposal(options.proposal)
	});

	options.store.snapshot().materialized.forEach(function (fields) {
		var platform = envelopes.platformOf(fields.title);

		if (
			platform === null ||
			fields.title === options.title
		) {
			return;
		}

		var envelope = envelopes.read(fields);

		if (envelope.kind !== "ready") {
			throw new Error(
				"Cannot establish work compatibility: " +
				fields.title
			);
		}

		var record = envelope.record;
		var other = null;

		if (record.kind === "continuation") {
			var continuation = continuations.validate(
				record,
				platform,
				fields.title
			);

			if (continuation.work !== null) {
				other = workView(continuation.work);
			}
		} else if (record.kind === "plan") {
			other = proposalView(record.proposal);
		} else if (
			record.kind === "flow" &&
			record.active !== null
		) {
			other = proposalView(record.active);
		}

		/*
			Pending events, diagnostics and registration receipts
			are not active material work.
		*/
		if (other === null) {
			return;
		}

		if (
			candidate.id !== null &&
			other.id === candidate.id
		) {
			throw new Error(
				"Work identity has another journal: " +
				fields.title
			);
		}

		if (conflicts(candidate, other)) {
			throw new Error(
				"Accepted work conflict: " + fields.title
			);
		}
	});

	return true;
}

exports.check = check;
exports.proposalView = proposalView;