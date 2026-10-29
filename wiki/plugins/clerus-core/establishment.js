/*\
title: $:/plugins/clerus/core/establishment.js
type: application/javascript
module-type: library
\*/

"use strict";

var missions = require("$:/plugins/clerus/core/missions.js");
var hierarchy = require("$:/plugins/clerus/core/hierarchy.js");
var documentFlow =
	require("$:/plugins/clerus/core/document-flow.js");
var effects = require("$:/plugins/clerus/core/effects.js");
var missionTransfer =
	require("$:/plugins/clerus/core/mission-transfer.js");

function establish(options) {
	var runtime = options.runtime;
	var source = options.source;
	var target = options.target;
	var contract = options.contract;
	var transfer = options.transferredMission;
	var prefix = "$:/temp/clerus/jobs/" + runtime.platform + "/";

	if (source.persistent) {
		throw new Error("Persistent orders require a work plan");
	}

	if (target.indexOf(prefix) !== 0) {
		throw new Error("Only local ephemeral recipients are supported");
	}

	if (runtime.wiki.getTiddler(target)) {
		throw new Error("Recipient already exists");
	}

	if (
		contract.temp !== undefined &&
		typeof contract.temp !== "boolean"
	) {
		throw new Error("Contract temp must be boolean");
	}

	if (contract.temp === false) {
		throw new Error("Contract forbids ephemeral establishment");
	}

	var original = runtime.inspect().jobs;
	var jobs = JSON.parse(JSON.stringify(original));
	var sender = jobs.find(function (job) {
		return job.title === source.title;
	});

	if (
		!sender ||
		!sender.valid ||
		!sender.local ||
		!sender.owned ||
		sender.executor !== source.executor
	) {
		throw new Error("Sender is no longer eligible");
	}

	if (
		JSON.stringify(sender.registry[options.contractKey]) !==
		JSON.stringify(contract)
	) {
		throw new Error("Contract has changed");
	}

	if (
		!Object.keys(sender.registry).some(function (key) {
			return sender.registry[key] === target;
		})
	) {
		throw new Error("Sender no longer holds the recipient title");
	}

	if (!missions.audit(original).valid) {
		throw new Error("Initial mission structure is invalid");
	}

	var registry = {
		charter: contract
	};

	if (transfer) {
		var preparedTransfer = missionTransfer.prepareDownward(
			jobs,
			source.title,
			transfer
		);

		registry.mission = transfer.document;

		preparedTransfer.keys.forEach(function (key) {
			delete sender.registry[key];
		});
	}

	(options.titleCopies || []).forEach(function (copy) {
		if (
			typeof copy.destinationKey !== "string" ||
			copy.destinationKey.length === 0 ||
			Object.prototype.hasOwnProperty.call(registry, copy.destinationKey)
		) {
			throw new Error("Invalid or occupied destination key");
		}

		if (sender.registry[copy.sourceKey] !== copy.title) {
			throw new Error("Selected title has changed");
		}

		// A persistent subordinate cannot belong to an ephemeral recipient.
		if (copy.title.indexOf("$:/clerus/jobs/") === 0) {
			throw new Error("Cannot give a persistent job title to an ephemeral job");
		}

		Object.defineProperty(registry, copy.destinationKey, {
			value: copy.title,
			enumerable: true,
			writable: true,
			configurable: true
		});
	});

	delete sender.registry[options.contractKey];

	var delivery = documentFlow.prepare(
		registry,
		{
			type: "order",
			establishing: true
		},
		options.rules
	);

	if (Object.keys(delivery.explicit).length > 0) {
		throw new Error(
			"Explicit documents in establishing orders are not supported yet"
		);
	}

	registry = delivery.automatic;

	jobs.push({
		title: target,
		persistent: false,
		local: true,
		owned: true,
		valid: true,
		custody: runtime.platform,
		executor: contract.executor,
		registry: registry
	});

	var graph = hierarchy.audit(jobs);

	if (!graph.valid || !graph.complete) {
		throw new Error("Establishment would violate hierarchy invariants");
	}

	if (!missions.audit(jobs).valid) {
		throw new Error("Establishment would violate mission invariants");
	}

	var plans = [];

	jobs.forEach(function (job) {
		if (job.title === target) {
			return;
		}

		var before = original.find(function (candidate) {
			return candidate.title === job.title;
		});

		if (JSON.stringify(before.registry) === JSON.stringify(job.registry)) {
			return;
		}

		if (
			!before.valid ||
			before.persistent ||
			!before.local ||
			(
				before.custody !== runtime.platform &&
				before.custody !== "user"
			)
		) {
			throw new Error("Affected jobs must be local and ephemeral");
		}

		var tiddler = runtime.wiki.getTiddler(job.title);

		if (!tiddler) {
			throw new Error("Affected job disappeared");
		}

		var removedKeys = Object.keys(before.registry).filter(function (key) {
			return !Object.prototype.hasOwnProperty.call(job.registry, key);
		});

		var lostRoles = new Map();

		removedKeys.forEach(function (key) {
			var document = before.registry[key];

			if (missions.isMission(document)) {
				lostRoles.set(
					JSON.stringify([document.project, document.role]),
					{
						project: document.project,
						role: document.role.slice()
					}
				);
			}
		});

		plans.push({
			title: job.title,
			executor: job.executor,
			tiddler: tiddler,
			registry: job.registry,
			removedKeys: removedKeys,
			roles: Array.from(lostRoles.values())
		});
	});

	// Preflight completed. Materialization remains ephemeral.
	var sourceRemovedKeys = [];

	plans.forEach(function (plan) {
		if (plan.title === source.title) {
			plan.removedKeys.forEach(function (key) {
				options.replace(key, undefined);
				sourceRemovedKeys.push(key);
			});
		} else {
			var effect = effects.put(
				plan.tiddler,
				new options.Tiddler(plan.tiddler, {
					text: JSON.stringify(plan.registry)
				})
			);

			effects.apply(runtime.wiki, options.Tiddler, effect);
		}
	});

	var creation = effects.put(
		null,
		new options.Tiddler({
			title: target,
			type: "application/json",
			"clerus-custody": runtime.platform,
			"clerus-executor": contract.executor,
			text: JSON.stringify(registry)
		})
	);

	effects.apply(runtime.wiki, options.Tiddler, creation);

	return { sourceRemovedKeys: sourceRemovedKeys };
}

exports.establish = establish;