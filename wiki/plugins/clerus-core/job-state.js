/*\
title: $:/plugins/clerus/core/job-state.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
);

/*
Interpret registry structure only.

Document support, charter cardinality and execution authority
belong to the corresponding consumers.
*/
function readRegistry(fields) {
	if (!schemas.isRecord(fields)) {
		throw new Error("Job fields must be a record");
	}

	if (fields.type !== "application/json") {
		return {
			kind: "unsupported",
			registry: null,
			reason: "Job must have type application/json"
		};
	}

	if (typeof fields.text !== "string") {
		return {
			kind: "unreadable",
			registry: null,
			reason: "Job must contain registry JSON"
		};
	}

	var parsed;

	try {
		parsed = JSON.parse(fields.text);
	} catch (error) {
		return {
			kind: "unreadable",
			registry: null,
			reason: "Invalid registry JSON: " + error.message
		};
	}

	if (!schemas.isRecord(parsed)) {
		return {
			kind: "unreadable",
			registry: null,
			reason: "Job registry must be a JSON record"
		};
	}

	return {
		kind: "ready",
		registry: schemas.copyJSON(parsed),
		reason: null
	};
}

/*
The enumerator supplies materialized field records and titles.
It may represent a live store or the current planning branch.

Enumeration failures are infrastructure failures and propagate.
*/
function readJobs(each) {
	if (typeof each !== "function") {
		throw new Error("Job projection requires an enumerator");
	}

	var jobs = [];

	each(function (fields, title) {
		if (!jobTitles.isJobTitle(title)) {
			return;
		}

		var state = readRegistry(fields);

		jobs.push({
			title: title,

			custody: hasOwn(fields, "clerus-custody")
				? fields["clerus-custody"]
				: "user",

			executor: fields["clerus-executor"] === undefined
				? null
				: fields["clerus-executor"],

			registry: state.registry
		});
	});

	jobs.sort(function (left, right) {
		return left.title < right.title
			? -1
			: left.title > right.title ? 1 : 0;
	});

	return schemas.copyJSON(jobs);
}

/*
A shared header predicate, not an execution authorization.

Custody, title locality, registry validity and lifecycle state
are checked by the corresponding execution contract.
*/
function hasExecutionHeader(fields) {
	return schemas.isRecord(fields) &&
		fields.type === "application/json" &&
		typeof fields["clerus-executor"] === "string" &&
		fields["clerus-executor"].length > 0;
}

/*
Read one job without hiding source failures.

The result preserves the physical view. Structural readiness
does not imply registry document support or execution authority.
*/
function read(source, title) {
	if (!jobTitles.isJobTitle(title)) {
		throw new Error("Invalid job title");
	}

	if (!source || typeof source.read !== "function") {
		throw new Error("Job reading requires a state reader");
	}

	var stored = source.read(title);

	if (
		!schemas.isRecord(stored) ||
		(
			stored.kind !== "absent" &&
			stored.kind !== "materialized" &&
			stored.kind !== "shadow"
		)
	) {
		throw new Error("Invalid stored job view");
	}

	if (stored.kind === "absent") {
		if (stored.fields !== null) {
			throw new Error("Absent job must have null fields");
		}

		return {
			kind: "absent",
			storage: "absent",
			fields: null,
			registry: null,
			reason: "Job does not exist"
		};
	}

	if (
		!schemas.isRecord(stored.fields) ||
		stored.fields.title !== title
	) {
		throw new Error("Stored job identity mismatch");
	}

	var fields = schemas.copyJSON(stored.fields);

	if (stored.kind === "shadow") {
		return {
			kind: "unsupported",
			storage: "shadow",
			fields: fields,
			registry: null,
			reason: "Job must be materialized"
		};
	}

	var state = readRegistry(fields);

	return {
		kind: state.kind,
		storage: "materialized",
		fields: fields,
		registry: state.registry,
		reason: state.reason
	};
}

/*
Build a private perspective with the owner's local operational
registry replacing its stored representation.

This is structural projection, not registry authorization.
A null registry represents an unestablished operational scope.

The returned owner intentionally belongs to the returned jobs.
Neither shares mutable data with the inputs.
*/
function overlayOwner(input, title, operational) {
	if (!jobTitles.isJobTitle(title)) {
		throw new Error("Owner projection requires a job title");
	}

	var jobs = schemas.copyJSON(input);

	if (
		!Array.isArray(jobs) ||
		!jobs.every(schemas.isRecord)
	) {
		throw new Error("Job reader must return job records");
	}

	if (
		operational !== null &&
		!schemas.isRecord(operational)
	) {
		throw new Error(
			"Owner projection requires an operational record or null"
		);
	}

	var owners = jobs.filter(function (job) {
		return job.title === title;
	});

	if (owners.length !== 1) {
		throw new Error(
			"Owner projection requires exactly one owner snapshot"
		);
	}

	var owner = owners[0];
	owner.registry = schemas.copyJSON(operational);

	return {
		jobs: jobs,
		owner: owner
	};
}

exports.readRegistry = readRegistry;
exports.readJobs = readJobs;
exports.hasExecutionHeader = hasExecutionHeader;
exports.read = read;
exports.overlayOwner = overlayOwner;