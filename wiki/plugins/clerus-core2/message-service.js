/*\
title: $:/plugins/clerus/core/message-service.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var policy = require("$:/plugins/clerus/core/message-policy.js");
var missionSchema = require(
	"$:/plugins/clerus/core/mission-schema.js"
);

function create(options) {
	schemas.assertPlatform(options.platform);

	if (
		!jobTitles.isJobTitle(options.title) ||
		typeof options.readJobs !== "function"
	) {
		throw new Error("Message service requires an owner and job reader");
	}

	function authorizeMissions(type, registry, scope, addressing) {
		var checked = schemas.registry(registry, "outgoing");

		Object.keys(checked).forEach(function (key) {
			var document = checked[key];

			if (
				!schemas.isRecord(document) ||
				document.form !== "mission"
			) {
				return;
			}

			if (typeof options.authorizeTransmission !== "function") {
				throw new Error(
					"Mission transmission authorization is unavailable"
				);
			}

			options.authorizeTransmission(
				type,
				missionSchema.validate(document),
				scope,
				addressing
			);
		});

		return checked;
	}

	function prepareOrder(target, registry, scope) {
		registry = authorizeMissions("order", registry, scope, null);
		var jobs = schemas.copyJSON(options.readJobs());

		if (!Array.isArray(jobs)) {
			throw new Error("Job reader must return an array");
		}

		var owners = jobs.filter(function (job) {
			return job.title === options.title;
		});

		if (owners.length !== 1) {
			throw new Error(
				"Message service requires exactly one owner snapshot"
			);
		}

		owners[0].registry = schemas.registry(
			scope.operational,
			"operational"
		);

		return policy.check({
			type: "order",
			platform: options.platform,
			source: options.title,
			recipient: target,
			jobs: jobs,
			registry: registry
		});
	}

	function prepareReport(document, registry, scope) {
		if (typeof options.resolveReport !== "function") {
			throw new Error("Report assignment authorization is unavailable");
		}

		registry = authorizeMissions(
			"report",
			registry,
			scope,
			document
		);

		var address = options.resolveReport(document, scope);
		var jobs = schemas.copyJSON(options.readJobs());

		if (!Array.isArray(jobs)) {
			throw new Error("Job reader must return an array");
		}

		var owners = jobs.filter(function (job) {
			return job.title === options.title;
		});

		if (owners.length !== 1) {
			throw new Error(
				"Message service requires exactly one owner snapshot"
			);
		}

		owners[0].registry = schemas.registry(
			scope.operational,
			"operational"
		);

		return policy.check({
			type: "report",
			platform: options.platform,
			source: options.title,
			recipient: address.recipient,
			project: address.project,
			role: address.role,
			jobs: jobs,
			registry: registry
		});
	}

	return Object.freeze({
		prepareOrder: prepareOrder,
		prepareReport: prepareReport
	});
}

exports.create = create;