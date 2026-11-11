/*\
title: $:/plugins/clerus/core/continuation-view.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);

exports.read = function (options) {
	schemas.assertPlatform(options.platform);

	var prefix = "$:/clerus/wal/" + options.platform + "/";
	var result = [];

	options.wiki.each(function (tiddler, title) {
		if (
			title.indexOf(prefix) !== 0 ||
			tiddler.fields["clerus-wal-kind"] !== "continuation"
		) {
			return;
		}

		var custody = tiddler.fields["clerus-custody"] || "user";

		var item = {
			title: title,
			custody: custody,
			error: null,
			state: null,
			record: null,
			events: [],
			actions: {
				release: false,
				hold: custody === options.platform
			}
		};

		try {
			if (tiddler.fields.type !== "application/json") {
				throw new Error("Continuation must have type application/json");
			}

			item.record = continuations.validate(
				JSON.parse(tiddler.fields.text),
				options.platform,
				title
			);
		} catch (error) {
			item.error = String(error.message);
			item.state = "invalid";
			result.push(item);
			return;
		}

		var record = item.record;
		var ids = Object.keys(record.events).sort();

		item.actions.release = custody === "user";

		item.events = ids.map(function (id) {
			var waiting = record.events[id];

			return {
				id: id,
				mode: waiting.mode,
				event: waiting.event,
				retry: custody === "user" &&
					record.work === null &&
					waiting.mode === "paused"
			};
		});

		if (record.work !== null) {
			item.state = "work";
		} else if (ids.length === 0) {
			item.state = "exhausted";
		} else if (item.events.every(function (entry) {
			return entry.mode === "paused";
		})) {
			item.state = "paused";
		} else {
			item.state = "ready";
		}

		result.push(item);
	});

	result.sort(function (left, right) {
		return left.title < right.title ? -1
			: left.title > right.title ? 1 : 0;
	});

	return result;
};