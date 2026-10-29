/*\
title: $:/plugins/clerus/core/materialization-barrier.js
type: application/javascript
module-type: library
\*/

"use strict";

function isRecord(value) {
	return value !== null &&
		typeof value === "object" &&
		!Array.isArray(value);
}

function collect(wiki, platform) {
	var prefix = "$:/clerus/wal/" + platform + "/";
	var blocked = new Map();
	var unreadable = [];

	function add(jobTitle, walTitle) {
		if (
			typeof jobTitle !== "string" ||
			jobTitle.indexOf("$:/clerus/jobs/") !== 0
		) {
			throw new Error("Invalid materialization owner or target");
		}

		if (!blocked.has(jobTitle)) {
			blocked.set(jobTitle, []);
		}

		blocked.get(jobTitle).push(walTitle);
	}

	function addActive(active, walTitle) {
		if (
			!isRecord(active) ||
			!isRecord(active.owner) ||
			!isRecord(active.plan)
		) {
			throw new Error("Invalid active materialization");
		}

		add(active.owner.title, walTitle);

		if (
			active.plan.appointments !== undefined &&
			!Array.isArray(active.plan.appointments)
		) {
			throw new Error("Invalid appointment list");
		}

		(active.plan.appointments || []).forEach(function (effect) {
			if (!effect || !effect.recipient) {
				throw new Error("Invalid appointment target");
			}

			add(effect.recipient.title, walTitle);
		});
	}

	wiki.each(function (tiddler, title) {
		if (title.indexOf(prefix) !== 0) {
			return;
		}

		try {
			var record = JSON.parse(tiddler.fields.text);
			var kind = tiddler.fields["clerus-wal-kind"];

			if (
				!isRecord(record) ||
				record.version !== 1 ||
				record.platform !== platform
			) {
				throw new Error("Invalid WAL envelope");
			}

			if (kind === "deferred") {
				return;
			}

			if (kind === "flow") {
				if (record.kind !== "flow") {
					throw new Error("Invalid flow envelope");
				}

				if (record.active !== null) {
					addActive(record.active, title);
				}

				return;
			}

			if (kind !== undefined) {
				throw new Error("Unknown WAL kind");
			}

			if (record.plan !== undefined) {
				addActive({
					owner: record.owner,
					plan: record.plan
				}, title);
			} else if (!isRecord(record.incident)) {
				throw new Error("Unknown WAL body");
			}
		} catch (error) {
			unreadable.push(title);
		}
	});

	return {
		forJob: function (title) {
			return unreadable.concat(blocked.get(title) || []).sort();
		},

		unreadable: unreadable.slice().sort()
	};
}

exports.collect = collect;