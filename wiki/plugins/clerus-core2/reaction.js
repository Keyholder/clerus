/*\
title: $:/plugins/clerus/core2/reaction.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var scopes = require("$:/plugins/clerus/core2/scope.js");
var transitions = require("$:/plugins/clerus/core2/store.js");
var jobTitles = require("$:/plugins/clerus/core2/job-titles.js");

var projectPerspectives = require(
	"$:/plugins/clerus/core2/project-perspective.js"
);
var organizations = require(
	"$:/plugins/clerus/core2/organization.js"
);
var messageServices = require(
	"$:/plugins/clerus/core2/message-service.js"
);
var titleIssuers = require(
	"$:/plugins/clerus/core2/title-issuer.js"
);
var jobViews = require("$:/plugins/clerus/core2/job-view.js");

function define(record, key, value) {
	Object.defineProperty(record, key, {
		value: value,
		enumerable: true,
		writable: true,
		configurable: true
	});
}

function freezeTree(value) {
	if (value !== null && typeof value === "object") {
		Object.keys(value).forEach(function (key) {
			freezeTree(value[key]);
		});

		Object.freeze(value);
	}

	return value;
}

function sameFields(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function run(options, establishing) {
	schemas.assertPlatform(options.platform);

	var store = options.store;

	if (
		!store ||
		typeof store.read !== "function" ||
		typeof store.apply !== "function"
	) {
		throw new Error("Reaction requires a store");
	}

	[
		"readJobs",
		"acceptMessage",
		"checkMessage",
		"newId",
		"checkDeferred",
		"acceptDeferred"
	].forEach(function (name) {
		if (
			options[name] !== undefined &&
			typeof options[name] !== "function"
		) {
			throw new Error(name + " must be a function");
		}
	});

	var incoming = options.incoming === undefined
		? undefined
		: schemas.registry(options.incoming, "incoming");

	var initial = store.read(options.title);
	var job;
	var handler;

	if (establishing) {
		var space = jobTitles.classify(options.title);

		if (
			!space ||
			space.persistent ||
			space.platform !== options.platform
		) {
			throw new Error(
				"Establishment requires a local ephemeral title"
			);
		}

		if (initial.kind !== "absent") {
			throw new Error("Establishment target must be absent");
		}

		if (incoming === undefined) {
			throw new Error("Establishment requires incoming documents");
		}

		var contracts = Object.keys(incoming).filter(function (key) {
			return schemas.formOf(incoming[key]) === "contract";
		});

		if (contracts.length !== 1) {
			throw new Error(
				"Establishment requires exactly one incoming contract"
			);
		}

		var contract = incoming[contracts[0]];

		if (contract.temp === false) {
			throw new Error("Contract forbids ephemeral establishment");
		}

		if (typeof options.resolveExecutor !== "function") {
			throw new Error("Establishment requires an executor resolver");
		}

		handler = options.resolveExecutor(contract.executor);

		job = {
			title: options.title,
			executor: contract.executor,
			registry: null
		};
	} else {
		if (initial.kind !== "materialized") {
			throw new Error("Reaction requires a materialized job");
		}

		job = schemas.ephemeralJob(
			initial.fields,
			options.platform
		);

		handler = options.handler;
	}

	if (typeof handler !== "function") {
		throw new Error("Reaction requires an available handler");
	}

	var event = schemas.copyJSON(
		establishing && options.event === undefined
			? { type: "order" }
			: options.event
	);

	if (
		!schemas.isRecord(event) ||
		typeof event.type !== "string" ||
		event.type.length === 0 ||
		(establishing && event.type !== "order")
	) {
		throw new Error("Reaction requires a valid event type");
	}

	define(event, "title", job.title);
	define(event, "platform", options.platform);
	freezeTree(event);

	var expected = initial.kind === "materialized"
		? schemas.copyJSON(initial.fields)
		: null;

	var scope = null;

	var projectPerspective = options.readJobs
		? projectPerspectives.create({
			title: job.title,
			platform: options.platform,
			store: store,
			readJobs: options.readJobs
		})
		: null;

	var organization = options.readJobs
		? organizations.create({
			title: job.title,
			readJobs: options.readJobs
		})
		: null;

	var messageService = options.readJobs
		? messageServices.create({
			title: job.title,
			platform: options.platform,
			readJobs: options.readJobs,
			resolveReport: projectPerspective.resolveReport,
			authorizeTransmission:
				projectPerspective.authorizeTransmission
		})
		: null;

	var titleIssuer = options.newId
		? titleIssuers.create({
			title: job.title,
			store: store,
			newId: options.newId,
			platform: options.platform
		})
		: null;

	function currentWritable() {
		if (expected === null) {
			return false;
		}

		var current = store.read(job.title);

		return current.kind === "materialized" &&
			current.fields["clerus-custody"] === options.platform &&
			current.fields["clerus-executor"] === job.executor &&
			current.fields.type === "application/json" &&
			sameFields(current.fields, expected);
	}

	function establishOperational(registry) {
		if (!establishing || expected !== null) {
			throw new Error("Job cannot be established again");
		}

		if (store.read(job.title).kind !== "absent") {
			throw new Error("Establishment target became occupied");
		}

		var normalized = schemas.registry(
			registry,
			"operational"
		);

		var effect = transitions.transition(job.title, null, {
			title: job.title,
			type: "application/json",
			"clerus-custody": options.platform,
			"clerus-executor": job.executor,
			text: JSON.stringify(normalized)
		});

		store.apply(effect);
		expected = effect.after;
	}

	function commitOperational(before, after) {
		if (!currentWritable()) {
			throw new Error(
				"Operational registry write precondition failed"
			);
		}

		var expectedRegistry = schemas.registry(
			JSON.parse(expected.text),
			"operational"
		);

		if (
			JSON.stringify(expectedRegistry) !==
			JSON.stringify(before)
		) {
			throw new Error(
				"Operational scope diverged from stored registry"
			);
		}

		var next = schemas.copyJSON(expected);
		define(next, "text", JSON.stringify(after));

		var effect = transitions.transition(
			job.title,
			expected,
			next
		);

		store.apply(effect);
		expected = effect.after;
	}

	try {
		scope = scopes.open({
			operational: job.registry,
			incoming: incoming,
			eventType: event.type,

			readTiddler: store.read.bind(store),

			readJob: function (title) {
				return jobViews.read(store, title);
			},

			readMission: projectPerspective
				? projectPerspective.readMission
				: undefined,

			authorizeMission: projectPerspective
				? projectPerspective.authorizeMutation
				: undefined,

			authorizeMissionMove: projectPerspective
				? projectPerspective.authorizeMove
				: undefined,

			authorizeOrganization: organization
				? organization.authorizeChange
				: undefined,

			prepareOrder: messageService
				? messageService.prepareOrder
				: undefined,

			prepareReport: messageService
				? messageService.prepareReport
				: undefined,

			issueJobTitle: titleIssuer
				? titleIssuer.issue
				: undefined,

			checkMessage: options.checkMessage,
			acceptMessage: options.acceptMessage,
			canWriteOperational: currentWritable,
			commitOperational: commitOperational,

			establishOperational: establishing
				? establishOperational
				: undefined,

			checkDeferred: typeof options.checkDeferred === "function"
				? function () {
					options.checkDeferred(job.title, job.executor);
				}
				: undefined,

			acceptDeferred: typeof options.acceptDeferred === "function"
				? function () {
					options.acceptDeferred(job.title, job.executor);
				}
				: undefined
		});

		var returned = handler(
			event,
			scope.operational,
			scope.incoming
		);

		if (
			returned !== null &&
			returned !== undefined &&
			typeof returned.then === "function"
		) {
			throw new Error("Executor reactions must be synchronous");
		}

		scope.assertResolved();

		if (options.requireSentOutgoing === true) {
			scope.assertOutgoingResolved();
		}

		var snapshot = scope.snapshot();

		return {
			outgoing: snapshot.outgoing,
			messages: snapshot.messages
		};
	} finally {
		if (scope) {
			scope.close();
		}
	}
}

exports.execute = function (options) {
	return run(options, false);
};

exports.establish = function (options) {
	return run(options, true);
};