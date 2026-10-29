/*\
title: $:/plugins/clerus/core/project-writer.js
type: application/javascript
module-type: library
\*/

"use strict";

var roles = require("$:/plugins/clerus/core/roles.js");
var missions = require("$:/plugins/clerus/core/missions.js");
var copyJSON = require("$:/plugins/clerus/core/json.js").copy;
var effects = require("$:/plugins/clerus/core/effects.js");
var states = require("$:/plugins/clerus/core/state.js");
var tiddlerViews =
	require("$:/plugins/clerus/core/tiddler-view.js");
var missionPerspective =
	require("$:/plugins/clerus/core/mission-perspective.js");

function createPart(options) {
	var runtime = options.runtime;
	var source = options.job;
	var document = options.document;
	var state = options.state ||
		states.live(runtime.wiki, options.Tiddler);

	if (source.persistent && state.mode !== "planned") {
		throw new Error("Persistent project writes require a work plan");
	}

	if (!roles.isSegment(options.segment)) {
		throw new Error("Invalid child task segment");
	}

	if (!missions.isMission(document)) {
		throw new Error("Document is not a valid mission");
	}

	if (!tiddlerViews.isOrdinaryTitle(document.project)) {
		throw new Error("Writable projects must have ordinary titles");
	}

	// Evaluate caller-supplied JSON before inspecting authoritative state.
	var task = copyJSON(options.task);
	var jobs = runtime.inspect().jobs;
	var currentJob = jobs.find(function (job) {
		return job.title === source.title;
	});

	if (
		!currentJob ||
		!currentJob.valid ||
		!currentJob.local ||
		!currentJob.owned ||
		currentJob.executor !== source.executor
	) {
		throw new Error("Job no longer has authority to modify a project");
	}

	var heldInRealState = Object.prototype.hasOwnProperty.call(
		currentJob.registry, options.key
	);

	if (
		(
			heldInRealState &&
			!missions.sameIdentity(
				currentJob.registry[options.key],
				document
			)
		) ||
		(!heldInRealState && state.mode !== "planned")
	) {
		throw new Error("Mission has changed outside this context");
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

	if (
		JSON.stringify(operationalRegistry[options.key]) !==
		JSON.stringify(document)
	) {
		throw new Error("Mission is absent from the current operation state");
	}

	if (!runtime.wiki.tiddlerExists(document.project)) {
		throw new Error("Project must already be materialized");
	}

	if (
		state.mode === "planned" &&
		runtime.wiki.isShadowTiddler(document.project)
	) {
		throw new Error("Shadow-backed projects are not supported in planned writes");
	}

	var realProject = runtime.wiki.getTiddler(document.project);

	if (realProject.fields["clerus-custody"] !== runtime.platform) {
		throw new Error("Project is not owned by this platform");
	}

	var project = state.getTiddler(document.project);

	if (
		!project ||
		project.fields["clerus-custody"] !== runtime.platform
	) {
		throw new Error("Project is unavailable in the current operation state");
	}

	jobs = missionPerspective.jobs(
		runtime,
		state,
		source.title
	);

	var view = missions.read(
		{
			getTiddler: state.getTiddler
		},
		jobs,
		source.title,
		document
	);

	if (!view.readable) {
		throw new Error(view.reason || "Task is unavailable");
	}

	var tree = JSON.parse(project.fields.text);
	var parent = missions.resolveNode(tree, document.role);

	if (
		Object.prototype.hasOwnProperty.call(
			parent.parts, options.segment
		)
	) {
		throw new Error("Child task already exists: " + options.segment);
	}

	Object.defineProperty(parent.parts, options.segment, {
		value: {
			task: task,
			parts: {}
		},
		enumerable: true,
		writable: true,
		configurable: true
	});

	state.apply(
		effects.put(
			project,
			new options.Tiddler(project, {
				text: JSON.stringify(tree)
			})
		)
	);
}

exports.createPart = createPart;