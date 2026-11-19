/*\
title: $:/plugins/clerus/core/reaction-services.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var jobViews = require("$:/plugins/clerus/core/job-view.js");
var projectPerspectives = require(
	"$:/plugins/clerus/core/project-perspective.js"
);
var organizations = require(
	"$:/plugins/clerus/core/organization.js"
);
var messageServices = require(
	"$:/plugins/clerus/core/message-service.js"
);
var titleIssuers = require(
	"$:/plugins/clerus/core/title-issuer.js"
);
var warrantGeneration = require(
	"$:/plugins/clerus/core/warrant-generation.js"
);
var storeTransitions = require(
	"$:/plugins/clerus/core/store.js"
);

function create(options) {
	schemas.assertPlatform(options.platform);

	if (!jobTitles.isJobTitle(options.title)) {
		throw new Error("Reaction services require a job title");
	}

	if (
		!options.store ||
		typeof options.store.read !== "function"
	) {
		throw new Error("Reaction services require a state reader");
	}

	["readJobs", "newId"].forEach(function (name) {
		if (
			options[name] !== undefined &&
			typeof options[name] !== "function"
		) {
			throw new Error(name + " must be a function");
		}
	});

	var project = options.readJobs
		? projectPerspectives.create({
			title: options.title,
			platform: options.platform,
			store: options.store,
			readJobs: options.readJobs
		})
		: null;

	var organization = options.readJobs
		? organizations.create({
			title: options.title,
			readJobs: options.readJobs
		})
		: null;

	var messages = options.readJobs
		? messageServices.create({
			title: options.title,
			platform: options.platform,
			readJobs: options.readJobs,
			resolveReport: project.resolveReport,
			authorizeTransmission: project.authorizeTransmission
		})
		: null;

	var titles = options.newId
		? titleIssuers.create({
			title: options.title,
			platform: options.platform,
			store: options.store,
			newId: options.newId
		})
		: null;

	return Object.freeze({
		readTiddler: options.store.read.bind(options.store),

		readJob: function (title) {
			return jobViews.read(options.store, title);
		},

		readWarrantBinding: project
			? project.readWarrantBinding
			: undefined,

		authorizeWarrantBinding: project
			? project.authorizeWarrantBinding
			: undefined,

		readWarrantSelection:
			typeof options.store.discoverWarrant === "function"
				? options.store.discoverWarrant.bind(options.store)
				: undefined,

		prepareWarrantGeneration:
			typeof options.newId === "function"
				? function (template, input) {
					var normalized = warrantGeneration.validate(template);

					/*
					Validate parameters before allocating an identity.
					The provisional title is never published.
					*/
					warrantGeneration.instantiate(
						normalized,
						input,
						normalized.titlePrefix + "validation",
						options.platform
					);

					var id = options.newId();

					if (typeof id !== "string" || id.length === 0) {
						throw new Error(
							"Generator requires a non-empty identity"
						);
					}

					var title = normalized.titlePrefix + id;

					if (options.store.read(title).kind !== "absent") {
						throw new Error("Generated title is occupied");
					}

					return storeTransitions.transition(
						title,
						null,
						warrantGeneration.instantiate(
							normalized,
							input,
							title,
							options.platform
						)
					);
				}
				: undefined,

		applyWarrantTransition:
			typeof options.store.apply === "function"
				? options.store.apply.bind(options.store)
				: undefined,

		readMission: project
			? project.readMission
			: undefined,

		readMissionParts: project
			? project.readParts
			: undefined,

		prepareMissionPart: project
			? project.preparePart
			: undefined,

		applyProjectTransition: project &&
			typeof options.store.apply === "function"
			? options.store.apply.bind(options.store)
			: undefined,

		authorizeMission: project
			? project.authorizeMutation
			: undefined,

		authorizeMissionMove: project
			? project.authorizeMove
			: undefined,

		authorizeOrganization: organization
			? organization.authorizeChange
			: undefined,

		prepareOrder: messages
			? messages.prepareOrder
			: undefined,

		prepareReport: messages
			? messages.prepareReport
			: undefined,

		issueJobTitle: titles
			? titles.issue
			: undefined
	});
}

exports.create = create;