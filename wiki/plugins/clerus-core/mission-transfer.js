/*\
title: $:/plugins/clerus/core/mission-transfer.js
type: application/javascript
module-type: library
\*/

"use strict";

var missions = require("$:/plugins/clerus/core/missions.js");
var links = require("$:/plugins/clerus/core/mission-links.js");

function prepareDownward(jobs, senderTitle, transfer) {
	var sender = jobs.find(function (job) {
		return job.title === senderTitle;
	});

	var document = transfer && transfer.document;

	if (
		!sender ||
		!sender.registry ||
		!missions.isMission(document) ||
		document.role.length === 0 ||
		!Object.prototype.hasOwnProperty.call(
			sender.registry, transfer.key
		) ||
		JSON.stringify(sender.registry[transfer.key]) !==
			JSON.stringify(document)
	) {
		throw new Error("Invalid mission transfer");
	}

	var active = links.evaluate(jobs).active;

	var held = active.find(function (entry) {
		return entry.title === senderTitle &&
			missions.sameIdentity(
				{
					form: "mission",
					project: entry.project,
					role: entry.role,
					link: entry.link,
					issued: entry.issued,
					children: entry.children
				},
				document
			);
	});

	if (!held) {
		throw new Error("Inactive mission cannot be transferred");
	}

	var parentRole = document.role.slice(0, -1);

	var retainsParent = active.some(function (entry) {
		return entry.title === senderTitle &&
			entry.project === document.project &&
			JSON.stringify(entry.role) === JSON.stringify(parentRole);
	});

	if (!retainsParent) {
		throw new Error("Sender must retain the active immediate parent mission");
	}

	return {
		keys: Object.keys(sender.registry).filter(function (key) {
			return missions.sameIdentity(
				sender.registry[key],
				document
			);
		})
	};
}

exports.prepareDownward = prepareDownward;