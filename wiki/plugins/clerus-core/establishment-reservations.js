/*\
title: $:/plugins/clerus/core/establishment-reservations.js
type: application/javascript
module-type: library
\*/

"use strict";

var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var envelopes = require("$:/plugins/clerus/core/wal-envelope.js");
var barriers = require(
	"$:/plugins/clerus/core/materialization-barrier.js"
);

var hasOwn = Function.call.bind(Object.prototype.hasOwnProperty);

function fromProposal(proposal) {
	var claims = [];

	if (proposal.owner.state === null) {
		claims.push({
			title: proposal.owner.title,
			kind: "birth"
		});
	}

	(proposal.plan.messages || []).forEach(function (message) {
		if (message.establishing === true) {
			claims.push({
				title: message.recipient.title,
				kind: "establishment"
			});
		}
	});

	return claims;
}

function fromWork(work, identities) {
	var claims = [];

	work.transitions.forEach(function (effect) {
		if (
			effect.before === null &&
			jobTitles.isJobTitle(effect.title)
		) {
			claims.push({
				title: effect.title,
				kind: "birth"
			});
		}
	});

	work.emits.forEach(function (effect) {
		if (
			effect.event.establishing === true &&
			!(
				identities &&
				hasOwn(identities, effect.id)
			)
		) {
			claims.push({
				title: effect.event.recipient.title,
				kind: "establishment"
			});
		}
	});

	return claims;
}

function fromRecord(record) {
	var claims = [];

	if (record.kind === "plan") {
		return fromProposal(record.proposal);
	}

	if (record.kind === "flow") {
		if (record.active !== null) {
			claims = claims.concat(
				fromProposal(record.active)
			);
		}

		record.pending.forEach(function (message) {
			if (message.establishing === true) {
				claims.push({
					title: message.recipient.title,
					kind: "establishment"
				});
			}
		});

		return claims;
	}

	if (record.kind === "continuation") {
		if (record.work !== null) {
			claims = claims.concat(fromWork(
				record.work,
				record.evidence.identities
			));
		}

		Object.keys(record.events).forEach(function (id) {
			var event = record.events[id].event;

			if (event.establishing === true) {
				claims.push({
					title: event.recipient.title,
					kind: "establishment"
				});
			}
		});
	}

	return claims;
}

/*
Claims are derived from accepted obligations.

User custody and paused event mode do not cancel reservations.
The caller supplies a validated candidate work/proposal.
*/
function check(options) {
	var knowledge = barriers.collect({
		store: options.store
	}).inspect();

	if (!knowledge.complete) {
		throw new Error(
			"Cannot establish address availability: unreadable WAL"
		);
	}

	var requested = new Set();

	options.claims.forEach(function (claim) {
		if (requested.has(claim.title)) {
			throw new Error(
				"Repeated establishment reservation in candidate"
			);
		}

		requested.add(claim.title);

		/*
			A pending establishment addresses absence.
			A birth work may already be partially materialized.
		*/
		if (
			claim.kind === "establishment" &&
			options.store.read(claim.title).kind !== "absent"
		) {
			throw new Error("Establishment target is occupied");
		}
	});

	if (requested.size === 0) {
		return true;
	}

	options.store.snapshot().materialized.forEach(function (fields) {
		if (
			envelopes.platformOf(fields.title) === null ||
			fields.title === options.title
		) {
			return;
		}

		var envelope = envelopes.read(fields);

		if (envelope.kind !== "ready") {
			throw new Error(
				"Cannot establish address availability: " +
				fields.title
			);
		}

		fromRecord(envelope.record).forEach(function (claim) {
			if (requested.has(claim.title)) {
				throw new Error(
					"Establishment address is reserved: " +
					claim.title
				);
			}
		});
	});

	return true;
}

exports.fromProposal = fromProposal;
exports.fromWork = fromWork;
exports.check = check;