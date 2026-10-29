/*\
title: $:/plugins/clerus/core/status-observer.js
type: application/javascript
module-type: library
\*/

"use strict";

var jobViews = require("$:/plugins/clerus/core/job-view.js");
var missions = require("$:/plugins/clerus/core/missions.js");
var tiddlerViews =
	require("$:/plugins/clerus/core/tiddler-view.js");

function StatusObserver() {
	this.previous = new Map();
}

StatusObserver.prototype.collect = function (
	jobs,
	readJob,
	readMission,
	readTiddler
) {
	var next = new Map();
	var events = [];

	jobs.forEach(function (job) {
		Object.keys(job.registry).forEach(function (key) {
			var document = job.registry[key];
			var identity;
			var target;
			var view;

			if (jobViews.isJobTitle(document)) {
				identity = JSON.stringify(["job", document]);
				target = document;
				view = readJob(document);
			} else if (tiddlerViews.isOrdinaryTitle(document)) {
				identity = JSON.stringify(["tiddler", document]);
				target = document;
				view = readTiddler(document);
			} else if (missions.isMission(document)) {
				identity = JSON.stringify([
					"mission",
					document.project,
					document.role,
					document.link
				]);
				target = document.project;
				view = readMission(job.title, document);
			} else {
				return;
			}

			var subscription = JSON.stringify([job.title, key]);
			var signature = JSON.stringify(view);
			var previous = this.previous.get(subscription);

			next.set(subscription, {
				identity: identity,
				signature: signature
			});

			if (
				previous &&
				previous.identity === identity &&
				previous.signature !== signature
			) {
				events.push({
					recipient: job.title,
					key: key,
					target: target,
					document: JSON.stringify(document)
				});
			}
		}, this);
	}, this);

	this.previous = next;

	return events;
};

StatusObserver.prototype.clear = function () {
	this.previous.clear();
};

exports.StatusObserver = StatusObserver;