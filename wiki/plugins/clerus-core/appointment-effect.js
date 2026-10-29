/*\
title: $:/plugins/clerus/core/appointment-effect.js
type: application/javascript
module-type: library
\*/

"use strict";

var copyJSON = require("$:/plugins/clerus/core/json.js").copy;
var documentFlow =
	require("$:/plugins/clerus/core/document-flow.js");
var messageEffects =
	require("$:/plugins/clerus/core/message-effect.js");
var effects = require("$:/plugins/clerus/core/effects.js");
var missions = require("$:/plugins/clerus/core/missions.js");
var hierarchy = require("$:/plugins/clerus/core/hierarchy.js");
var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var jobViews = require("$:/plugins/clerus/core/job-view.js");

function message(effect) {
	return messageEffects.create({
		id: effect.id + "-order",
		message: "order",
		source: effect.source,
		recipient: effect.recipient,
		registry: {}
	}, new Map());
}

function validate(effect) {
	if (
		!effect ||
		effect.version !== 1 ||
		effect.kind !== "appointment" ||
		typeof effect.id !== "string" ||
		!/^[A-Za-z0-9_-]+$/.test(effect.id) ||
		!effect.source ||
		!effect.recipient ||
		typeof effect.source.title !== "string" ||
		effect.source.title.indexOf("$:/clerus/jobs/") !== 0 ||
		typeof effect.recipient.title !== "string" ||
		effect.recipient.title.indexOf("$:/clerus/jobs/") !== 0 ||
		effect.source.title === effect.recipient.title ||
		!effect.contract ||
		effect.contract.form !== "contract" ||
		effect.contract.executor !== effect.recipient.executor ||
		(
			effect.contract.temp !== undefined &&
			effect.contract.temp !== false
		) ||
		!effect.registry ||
		typeof effect.registry !== "object" ||
		Array.isArray(effect.registry) ||
		!effect.registry.charter ||
		effect.registry.charter.form !== "charter" ||
		Object.keys(effect.registry).some(function (key) {
			if (key === "charter" || key === "mission") {
				return false;
			}

			return !jobViews.isJobTitle(effect.registry[key]);
		}) ||
		(
			Object.prototype.hasOwnProperty.call(effect.registry, "mission") &&
			(
				!missions.isMission(effect.registry.mission) ||
				effect.registry.mission.role.length === 0
			)
		)
	) {
		throw new Error("Invalid persistent appointment effect");
	}

	message(effect);
	copyJSON(effect);
}

function create(options, rules) {
	if (
		options.contract.temp !== undefined &&
		options.contract.temp !== false
	) {
		throw new Error("Contract does not permit persistent establishment");
	}

	var outgoing = {
		charter: options.contract
	};

	if (options.mission !== undefined) {
		outgoing.mission = options.mission;
	}

	var titles = options.titles || {};

	if (
		titles === null ||
		typeof titles !== "object" ||
		Array.isArray(titles)
	) {
		throw new Error("Appointment titles must be an object");
	}

	Object.keys(titles).forEach(function (key) {
		if (
			key.length === 0 ||
			key === "charter" ||
			key === "mission" ||
			!jobViews.isJobTitle(titles[key])
		) {
			throw new Error("Invalid appointment title document");
		}

		Object.defineProperty(outgoing, key, {
			value: titles[key],
			enumerable: true,
			writable: true,
			configurable: true
		});
	});

	var delivery = documentFlow.prepare(
		outgoing,
		{ type: "order", establishing: true },
		rules
	);

	var effect = {
		version: 1,
		kind: "appointment",
		id: options.id,
		source: copyJSON(options.source),
		recipient: copyJSON(options.recipient),
		contract: copyJSON(options.contract),
		registry: copyJSON(delivery.automatic)
	};

	validate(effect);

	return effect;
}

function materialize(wiki, Tiddler, effect) {
	validate(effect);

	if (wiki.isShadowTiddler(effect.recipient.title)) {
		throw new Error("Appointment target became shadow-backed");
	}

	var runtime = new Runtime({
		wiki: wiki,
		platform: effect.recipient.platform
	});

	var jobs = runtime.inspect().jobs;

	if (!wiki.tiddlerExists(effect.recipient.title)) {
		jobs.push({
			title: effect.recipient.title,
			persistent: true,
			registry: effect.registry
		});
	}

	var graph = hierarchy.audit(jobs);
	var assignments = missions.audit(jobs);

	if (!graph.valid || !graph.complete || !assignments.valid) {
		throw new Error("Appointment would violate current structural invariants");
	}

	var tiddler = new Tiddler({
		title: effect.recipient.title,
		type: "application/json",
		"clerus-custody": effect.recipient.platform,
		"clerus-executor": effect.recipient.executor,
		"clerus-instance": effect.id,
		"clerus-start": effect.id + "-order",
		text: JSON.stringify(effect.registry)
	});

	return effects.apply(wiki, Tiddler, effects.put(null, tiddler));
}

exports.create = create;
exports.validate = validate;
exports.message = message;
exports.materialize = materialize;