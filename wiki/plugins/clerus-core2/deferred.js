/*\
title: $:/plugins/clerus/core2/deferred.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");

function create(options) {
	schemas.assertPlatform(options.platform);

	if (
		!options.store ||
		typeof options.store.read !== "function" ||
		typeof options.newId !== "function"
	) {
		throw new Error("Deferred activation requires a store and identity source");
	}

	var pending = new Map();
	var running = false;

	function check(title, executor) {
		var stored = options.store.read(title);

		if (stored.kind !== "materialized") {
			throw new Error("Deferred recipient is not materialized");
		}

		var job = schemas.ephemeralJob(
			stored.fields,
			options.platform
		);

		if (job.executor !== executor) {
			throw new Error("Deferred recipient executor has changed");
		}

		var previous = pending.get(title);

		if (previous && previous.executor !== executor) {
			throw new Error("Another executor has a pending activation");
		}
	}

	function request(title, executor) {
		check(title, executor);

		if (pending.has(title)) {
			return;
		}

		var id = options.newId();

		if (
			typeof id !== "string" ||
			!/^[A-Za-z0-9_-]{16,128}$/.test(id)
		) {
			throw new Error("Invalid deferred activation identity");
		}

		pending.set(title, {
			title: title,
			executor: executor,
			id: id
		});
	}

	function drain(dispatch) {
		if (running) {
			throw new Error("Deferred activation pass is already running");
		}

		if (typeof dispatch !== "function") {
			throw new Error("Deferred activation requires a dispatcher");
		}

		var batch = Array.from(pending.values());
		var report = {
			delivered: [],
			skipped: [],
			errors: [],
			remaining: 0
		};

		/*
			Only this initial batch belongs to the pass.
			New requests made by ticks remain for the next pass.
		*/
		batch.forEach(function (work) {
			pending.delete(work.title);
		});

		running = true;

		try {
			batch.forEach(function (work) {
				try {
					check(work.title, work.executor);
				} catch (error) {
					report.skipped.push({
						title: work.title,
						id: work.id,
						error: String(error && error.message || error)
					});

					return;
				}

				try {
					report.delivered.push({
						title: work.title,
						id: work.id,

						result: dispatch(work.title, {
							type: "tick",
							id: work.id
						})
					});
				} catch (error) {
					report.errors.push({
						title: work.title,
						id: work.id,
						error: String(error && error.message || error)
					});
				}
			});
		} finally {
			running = false;
			report.remaining = pending.size;
		}

		return report;
	}

	return Object.freeze({
		check: check,
		request: request,
		drain: drain,

		inspect: function () {
			return schemas.copyJSON(Array.from(pending.values()));
		}
	});
}

exports.create = create;