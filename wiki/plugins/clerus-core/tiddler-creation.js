/*\
title: $:/plugins/clerus/core/tiddler-creation.js
type: application/javascript
module-type: library
\*/

"use strict";

var roles = require("$:/plugins/clerus/core/roles.js");
var copyJSON = require("$:/plugins/clerus/core/json.js").copy;
var tiddlerViews =
	require("$:/plugins/clerus/core/tiddler-view.js");
var tiddlerWriter =
	require("$:/plugins/clerus/core/tiddler-writer.js");
var effects = require("$:/plugins/clerus/core/effects.js");
var states = require("$:/plugins/clerus/core/state.js");
var warrantMission =
	require("$:/plugins/clerus/core/warrant-mission.js");

function isRecord(value) {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value);
}

function render(warrant, templateName, parameters) {
	tiddlerWriter.validateWarrant(warrant);

	if (warrant.operations.indexOf("create") === -1) {
		throw new Error("Warrant does not allow creation");
	}

	if (
		typeof templateName !== "string" ||
		!isRecord(warrant.templates) ||
		!Object.prototype.hasOwnProperty.call(warrant.templates, templateName)
	) {
		throw new Error("Unknown creation template");
	}

	var template = warrant.templates[templateName];
	var values = copyJSON(parameters);

	if (
		!isRecord(template) ||
		typeof template.title !== "string" ||
		!isRecord(template.parameters) ||
		!isRecord(template.fields) ||
		!isRecord(values)
	) {
		throw new Error("Invalid creation template or parameters");
	}

	Object.keys(template.parameters).forEach(function (name) {
		var kind = template.parameters[name];

		if (
			!/^[A-Za-z][A-Za-z0-9_]*$/.test(name) ||
			(kind !== "segment" && kind !== "string") ||
			!Object.prototype.hasOwnProperty.call(values, name) ||
			typeof values[name] !== "string"
		) {
			throw new Error("Invalid or missing template parameter: " + name);
		}

		if (kind === "segment" && !roles.isSegment(values[name])) {
			throw new Error("Invalid segment parameter: " + name);
		}
	});

	Object.keys(values).forEach(function (name) {
		if (!Object.prototype.hasOwnProperty.call(template.parameters, name)) {
			throw new Error("Unexpected template parameter: " + name);
		}
	});

	function substitute(text, inTitle) {
		if (typeof text !== "string") {
			throw new Error("Template fields must be strings");
		}

		var pattern = /\{\{([A-Za-z][A-Za-z0-9_]*)\}\}/g;
		var remainder = text.replace(pattern, "");

		if (remainder.indexOf("{{") !== -1 || remainder.indexOf("}}") !== -1) {
			throw new Error("Malformed template placeholder");
		}

		return text.replace(pattern, function (placeholder, name) {
			if (!Object.prototype.hasOwnProperty.call(template.parameters, name)) {
				throw new Error("Undeclared template parameter: " + name);
			}

			if (inTitle && template.parameters[name] !== "segment") {
				throw new Error("Title parameters must have segment type");
			}

			return values[name];
		});
	}

	var title = substitute(template.title, true);

	if (!tiddlerViews.isOrdinaryTitle(title)) {
		throw new Error("Template must produce an ordinary tiddler title");
	}

	var followup = template.followup === undefined
		? []
		: template.followup;

	if (
		!Array.isArray(followup) ||
		!followup.every(function (operation) {
			return operation === "patch" || operation === "delete";
		})
	) {
		throw new Error("Invalid template followup operations");
	}

	var fields = Object.create(null);

	Object.keys(template.fields).forEach(function (field) {
		tiddlerWriter.validateFieldName(field);
		fields[field] = substitute(template.fields[field], false);
	});

	return {
		title: title,
		followup: followup.slice(),
		fields: fields
	};
}

function create(options) {
	var runtime = options.runtime;
	var state = options.state ||
		states.live(runtime.wiki, options.Tiddler);
	var source = options.job;

	// Resolve caller-supplied parameters before inspecting current state.
	var result = render(
		options.warrant,
		options.templateName,
		options.parameters
	);

	if (source.persistent && state.mode !== "planned") {
		throw new Error("Persistent tiddler creation requires a work plan");
	}

	if (
		typeof options.destinationKey !== "string" ||
		options.destinationKey.length === 0
	) {
		throw new Error("Destination key must be non-empty");
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
		throw new Error("Job no longer has creation authority");
	}

	if (
		JSON.stringify(current.registry[options.warrantKey]) !==
		JSON.stringify(options.warrant)
	) {
		throw new Error("Creation warrant has changed");
	}

	var operationalJob = state.getTiddler(source.title);

	if (
		!operationalJob ||
		operationalJob.fields.type !== "application/json" ||
		operationalJob.fields["clerus-custody"] !== runtime.platform ||
		operationalJob.fields["clerus-executor"] !== source.executor
	) {
		throw new Error("Job is unavailable in the current operation state");
	}

	var operationalRegistry = JSON.parse(operationalJob.fields.text);

	if (
		JSON.stringify(operationalRegistry[options.warrantKey]) !==
			JSON.stringify(options.warrant)
	) {
		throw new Error("Creation warrant has changed in operation state");
	}

	warrantMission.authorize({
		runtime: runtime,
		state: state,
		job: source,
		warrant: options.warrant
	});

	if (
		Object.prototype.hasOwnProperty.call(
			operationalRegistry, options.destinationKey
		)
	) {
		throw new Error("Document key already exists");
	}

	if (state.creation && state.creation(result.title)) {
		throw new Error("Template target was already created in this plan");
	}

	if (
		runtime.wiki.getTiddler(result.title) ||
		state.getTiddler(result.title)
	) {
		throw new Error("Template target already exists");
	}

	var effect = effects.put(
		null,
		new options.Tiddler(
			result.fields,
			{
				title: result.title,
				"clerus-custody": runtime.platform
			}
		)
	);

	state.apply(effect);

	options.replace(options.destinationKey, result.title, {
		insert: true
	});

	if (state.rememberCreation) {
		state.rememberCreation(result.title, {
			warrant: options.warrant,
			templateName: options.templateName,
			followup: result.followup
		});
	}

	return result.title;
}

exports.render = render;
exports.create = create;