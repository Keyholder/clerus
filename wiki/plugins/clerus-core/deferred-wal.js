/*\
title: $:/plugins/clerus/core/deferred-wal.js
type: application/javascript
module-type: library
\*/

"use strict";

var effects = require("$:/plugins/clerus/core/effects.js");
var deferredEffects =
	require("$:/plugins/clerus/core/deferred-effect.js");

function titleFor(flow, effect) {
	return flow.prefix + "deferred-" + effect.id;
}

function record(flow, effect) {
	deferredEffects.validate(effect);

	if (effect.recipient.platform !== flow.platform) {
		throw new Error("Cannot register a foreign deferred event");
	}

	var title = titleFor(flow, effect);
	var serialized = JSON.stringify(effect);
	var existing = flow.wiki.getTiddler(title);

	if (existing) {
		if (existing.fields["clerus-deferred-effect"] !== serialized) {
			throw new Error("Deferred identity was reused");
		}

		return title;
	}

	effects.apply(
		flow.wiki,
		flow.Tiddler,
		effects.put(null, new flow.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": flow.platform,
			"clerus-wal-kind": "deferred",
			"clerus-deferred-effect": serialized,
			text: JSON.stringify({
				version: 1,
				kind: "deferred",
				platform: flow.platform,
				effect: effect
			})
		}))
	);

	return title;
}

function read(flow, title) {
	var tiddler = flow.wiki.getTiddler(title);

	if (
		!tiddler ||
		tiddler.fields.type !== "application/json" ||
		tiddler.fields["clerus-wal-kind"] !== "deferred" ||
		tiddler.fields["clerus-custody"] !== flow.platform
	) {
		throw new Error("Deferred WAL is not locally owned");
	}

	var body = JSON.parse(tiddler.fields.text);

	if (
		body.version !== 1 ||
		body.kind !== "deferred" ||
		body.platform !== flow.platform
	) {
		throw new Error("Invalid deferred WAL");
	}

	deferredEffects.validate(body.effect);

	if (
		body.effect.recipient.platform !== flow.platform ||
		title !== titleFor(flow, body.effect) ||
		tiddler.fields["clerus-deferred-effect"] !==
			JSON.stringify(body.effect)
	) {
		throw new Error("Deferred WAL identity mismatch");
	}

	return {
		tiddler: tiddler,
		effect: body.effect
	};
}

function checkRecipient(effect, job, id) {
	if (
		effect.id !== id ||
		!job.persistent ||
		effect.recipient.title !== job.title ||
		effect.recipient.executor !== job.executor
	) {
		throw new Error("Deferred event belongs to another recipient");
	}
}

function convert(flow, tiddler, body, custody) {
	effects.apply(
		flow.wiki,
		flow.Tiddler,
		effects.put(tiddler, new flow.Tiddler(tiddler, {
			"clerus-wal-kind": "flow",
			"clerus-custody": custody,
			text: JSON.stringify(body)
		}))
	);
}

function accept(flow, title, id, job, ownerState, plan) {
	var loaded = read(flow, title);

	checkRecipient(loaded.effect, job, id);

	var body = {
		version: 1,
		kind: "flow",
		platform: flow.platform,
		active: {
			owner: {
				title: job.title,
				executor: job.executor,
				state: ownerState
			},
			plan: plan
		},
		pending: [],
		seen: {},
		errors: []
	};

	flow.checkActive(body.active, body.seen);
	convert(flow, loaded.tiddler, body, flow.platform);
}

function fail(flow, title, id, job, error) {
	var loaded = read(flow, title);

	checkRecipient(loaded.effect, job, id);

	convert(flow, loaded.tiddler, {
		version: 1,
		kind: "flow",
		platform: flow.platform,
		active: null,
		pending: [],
		seen: {},
		errors: [{
			owner: {
				title: job.title,
				executor: job.executor
			},
			event: {
				type: "tick",
				id: id
			},
			error: error
		}]
	}, "user");
}

function pending(flow) {
	var result = [];

	flow.wiki.each(function (tiddler, title) {
		if (
			title.indexOf(flow.prefix) !== 0 ||
			tiddler.fields["clerus-wal-kind"] !== "deferred" ||
			tiddler.fields["clerus-custody"] !== flow.platform
		) {
			return;
		}

		try {
			result.push({
				title: title,
				effect: read(flow, title).effect
			});
		} catch (error) {
			flow.guard.pause(title, error);
		}
	});

	return result;
}

exports.record = record;
exports.read = read;
exports.accept = accept;
exports.fail = fail;
exports.pending = pending;