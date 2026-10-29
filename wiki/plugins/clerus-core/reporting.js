/*\
title: $:/plugins/clerus/core/reporting.js
type: application/javascript
module-type: library
\*/

"use strict";

var missions = require("$:/plugins/clerus/core/missions.js");
var hierarchy = require("$:/plugins/clerus/core/hierarchy.js");
var documentFlow =
	require("$:/plugins/clerus/core/document-flow.js");
var reportAddress =
	require("$:/plugins/clerus/core/report-address.js");
var jobViews = require("$:/plugins/clerus/core/job-view.js");
var effects = require("$:/plugins/clerus/core/effects.js");

function report(options) {
	var runtime = options.runtime;
	var source = options.source;
	var document = options.document;

	if (source.persistent) {
		throw new Error("Persistent assignment reports require a work plan");
	}

	var address = reportAddress.resolve(options);
	var jobs = JSON.parse(JSON.stringify(address.jobs));
	var sender = jobs.find(function (job) {
		return job.title === address.sender.title;
	});
	var recipient = jobs.find(function (job) {
		return job.title === address.recipient.title;
	});

	if (
		JSON.stringify(sender.registry[options.key]) !==
			JSON.stringify(document)
	) {
		throw new Error("Mission has changed outside this context");
	}

	var incoming = Object.create(null);

	function receive(key, value) {
		if (
			typeof key !== "string" ||
			key.length === 0 ||
			Object.prototype.hasOwnProperty.call(recipient.registry, key) ||
			Object.prototype.hasOwnProperty.call(incoming, key)
		) {
			throw new Error("Invalid or occupied recipient key");
		}

		Object.defineProperty(incoming, key, {
			value: value,
			enumerable: true,
			writable: true,
			configurable: true
		});
	}

	receive(options.destinationKey, document);

	(options.titleCopies || []).forEach(function (copy) {
		if (
			!jobViews.isJobTitle(copy.title) ||
			sender.registry[copy.sourceKey] !== copy.title
		) {
			throw new Error("Invalid or changed title selection");
		}

		receive(copy.destinationKey, copy.title);
	});

	var delivery = documentFlow.prepare(
		incoming,
		{ type: "report", establishing: false },
		options.rules
	);

	if (Object.keys(delivery.explicit).length > 0) {
		throw new Error("Explicit documents in assignment reports are unsupported");
	}

	Object.keys(delivery.automatic).forEach(function (key) {
		Object.defineProperty(recipient.registry, key, {
			value: delivery.automatic[key],
			enumerable: true,
			writable: true,
			configurable: true
		});
	});

	var removedKeys = Object.keys(sender.registry).filter(function (key) {
		return missions.sameIdentity(sender.registry[key], document);
	});

	removedKeys.forEach(function (key) {
		delete sender.registry[key];
	});

	var graph = hierarchy.audit(jobs);

	if (!graph.valid || !graph.complete) {
		throw new Error("Report would violate hierarchy invariants");
	}

	if (!missions.audit(jobs).valid) {
		throw new Error("Report would violate mission invariants");
	}

	var received = missions.read(
		runtime.wiki,
		jobs,
		recipient.title,
		document
	);

	if (!received.active) {
		throw new Error("Transferred mission would be inactive at the recipient");
	}

	var recipientTiddler = runtime.wiki.getTiddler(recipient.title);

	if (!recipientTiddler) {
		throw new Error("Report recipient disappeared");
	}

	var recipientEffect = effects.put(
		recipientTiddler,
		new options.Tiddler(recipientTiddler, {
			text: JSON.stringify(recipient.registry)
		})
	);

	// Preflight is complete. Only the two participating registries change.
	options.replace(options.key, undefined, {
		removeKeys: removedKeys.filter(function (key) {
			return key !== options.key;
		})
	});

	effects.apply(runtime.wiki, options.Tiddler, recipientEffect);

	return {
		recipient: recipient.title,
		executor: recipient.executor,
		project: document.project,
		role: document.role.slice(),
		registry: JSON.parse(JSON.stringify(delivery.registry)),
		sourceRemovedKeys: removedKeys
	};
}

exports.report = report;