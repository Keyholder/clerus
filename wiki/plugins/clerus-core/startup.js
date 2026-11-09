/*\
title: $:/plugins/clerus/core/startup.js
type: application/javascript
module-type: startup
\*/

"use strict";

exports.name = "clerus-runtime";
exports.after = ["startup"];
exports.before = ["render"];
exports.synchronous = true;

exports.startup = function () {
	if ($tw.clerus) {
		return;
	}

	var platform = $tw.browser ? "browser" : "node";
	var management = require(
		"$:/plugins/clerus/core/management.js"
	).create({
		tw: $tw,
		wiki: $tw.wiki,
		platform: platform
	});

	Object.defineProperty($tw, "clerus", {
		value: management,
		enumerable: true,
		writable: false,
		configurable: false
	});

	$tw.rootWidget.addEventListener("tm-clerus", function (event) {
		var parameters = event.paramObject || {};

		try {
			management.command(
				parameters.command,
				parameters.title,
				parameters.eventId
			);
		} catch (error) {
			console.error("Clerus management:", error);
		}

		return false;
	});

	management.start();
};