/*\
title: $:/plugins/clerus/core/tiddler-writer.js
type: application/javascript
module-type: library
\*/

"use strict";

var copyJSON = require("$:/plugins/clerus/core/json.js").copy;
var filterViews =
	require("$:/plugins/clerus/core/filter-view.js");
var tiddlerViews =
	require("$:/plugins/clerus/core/tiddler-view.js");
var effects = require("$:/plugins/clerus/core/effects.js");
var states = require("$:/plugins/clerus/core/state.js");
var warrantMission =
	require("$:/plugins/clerus/core/warrant-mission.js");

function isRecord(value) {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value);
}

function validateWarrant(document) {
	if (
		!isRecord(document) ||
		document.form !== "warrant" ||
		typeof document.filter !== "string" ||
		!Array.isArray(document.operations) ||
		!document.operations.every(function (operation) {
			return operation === "create" ||
				operation === "patch" ||
				operation === "delete";
		}) ||
		!Array.isArray(document.fields) ||
		!document.fields.every(function (field) {
			return typeof field === "string" && field.length > 0;
		})
	) {
		throw new Error("Invalid write warrant");
	}

	warrantMission.validate(document);
}

function validateFieldName(field) {
	if (
		typeof field !== "string" ||
		field.length === 0 ||
		/[\u0000-\u001f\u007f]/.test(field) ||
		field === "title" ||
		field === "clerus-custody" ||
		field === "__proto__" ||
		field === "constructor" ||
		field === "prototype"
	) {
		throw new Error("Protected or invalid field: " + field);
	}
}

function checkField(field, warrant) {
	validateFieldName(field);

	if (warrant.fields.indexOf(field) === -1) {
		throw new Error("Warrant does not allow field: " + field);
	}
}

function write(options) {
	var runtime = options.runtime;
	var source = options.job;
	var warrant = options.warrant;
	var operation = options.operation;
	var state = options.state ||
		states.live(runtime.wiki, options.Tiddler);

	// Evaluate caller-supplied JSON before inspecting authoritative state.
	var patch = operation === "patch" ? copyJSON(options.patch) : null;

	if (source.persistent && state.mode !== "planned") {
		throw new Error("Persistent tiddler writes require a work plan");
	}

	if (
		state.mode === "planned" &&
		runtime.wiki.isShadowTiddler(options.title)
	) {
		throw new Error("Shadow-backed targets are not supported in planned writes");
	}

	if (!tiddlerViews.isOrdinaryTitle(options.title)) {
		throw new Error("Only ordinary tiddlers can be modified");
	}

	validateWarrant(warrant);

	if (warrant.operations.indexOf(operation) === -1) {
		throw new Error("Warrant does not allow operation: " + operation);
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
		throw new Error("Job no longer has write authority");
	}

	var operationalJob = state.getTiddler(source.title);

	if (
		!operationalJob ||
		operationalJob.fields["clerus-custody"] !== runtime.platform ||
		operationalJob.fields["clerus-executor"] !== source.executor
	) {
		throw new Error("Job is unavailable in the current operation state");
	}

	var operationalRegistry = JSON.parse(operationalJob.fields.text);

	if (operationalRegistry[options.documentKey] !== options.title) {
		throw new Error("Title document has changed");
	}

	if (
		JSON.stringify(current.registry[options.warrantKey]) !==
			JSON.stringify(warrant) ||
		JSON.stringify(operationalRegistry[options.warrantKey]) !==
			JSON.stringify(warrant)
	) {
		throw new Error("Write warrant has changed");
	}

	warrantMission.authorize({
		runtime: runtime,
		state: state,
		job: source,
		warrant: warrant
	});

	var origin = state.creation
		? state.creation(options.title)
		: null;

	if (origin) {
		if (
			JSON.stringify(origin.warrant) !== JSON.stringify(warrant)
		) {
			throw new Error("Creation provenance belongs to another warrant");
		}

		if (origin.followup.indexOf(operation) === -1) {
			throw new Error("Template does not allow followup operation: " + operation);
		}
	} else {
		var allowed = filterViews.titles(runtime.wiki, {
			form: "filter",
			filter: warrant.filter
		});

		if (allowed.indexOf(options.title) === -1) {
			throw new Error("Warrant does not cover this tiddler");
		}

		if (!runtime.wiki.tiddlerExists(options.title)) {
			throw new Error("Target must be a materialized tiddler");
		}
	}

	var target = state.getTiddler(options.title);

	if (!target) {
		throw new Error("Target is absent in the current operation state");
	}

	if (target.fields["clerus-custody"] !== runtime.platform) {
		throw new Error("Target tiddler is not owned by this platform");
	}

	if (operation === "delete") {
		state.apply(effects.remove(target));
		return;
	}

	if (operation !== "patch" || !isRecord(patch)) {
		throw new Error("Invalid write operation");
	}

	var set = patch.set === undefined ? {} : patch.set;
	var remove = patch.remove === undefined ? [] : patch.remove;

	if (!isRecord(set) || !Array.isArray(remove)) {
		throw new Error("Patch requires a set object and a remove array");
	}

	var changes = Object.create(null);

	Object.keys(set).forEach(function (field) {
		checkField(field, warrant);

		if (typeof set[field] !== "string") {
			throw new Error("Field values must be strings");
		}

		changes[field] = set[field];
	});

	remove.forEach(function (field) {
		checkField(field, warrant);

		if (Object.prototype.hasOwnProperty.call(set, field)) {
			throw new Error("Cannot set and remove the same field");
		}

		changes[field] = undefined;
	});

	var effect = effects.put(
		target,
		new options.Tiddler(target, changes)
	);

	state.apply(effect);
}

exports.write = write;
exports.validateWarrant = validateWarrant;
exports.validateFieldName = validateFieldName;