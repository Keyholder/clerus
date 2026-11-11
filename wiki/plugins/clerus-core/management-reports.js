/*\
title: $:/plugins/clerus/core/management-reports.js
type: application/javascript
module-type: library
\*/

"use strict";

exports.create = function (options) {
	var wiki = options.wiki;
	var Tiddler = options.Tiddler;
	var reportTitle = "$:/temp/clerus/management/" + options.platform;
	var manualReportTitle = reportTitle + "/manual";
	var automaticStateTitle = reportTitle + "/automatic";

	function publishAutomaticState() {
		var serialized = JSON.stringify(options.automaticState());
		var current = wiki.getTiddler(automaticStateTitle);

		if (
			current &&
			current.fields.type === "application/json" &&
			current.fields.text === serialized
		) {
			return;
		}

		wiki.addTiddler(new Tiddler({
			title: automaticStateTitle,
			type: "application/json",
			text: serialized
		}));
	}

	function publish(command, result, error, origin) {
		var source = origin || "manual";

		var serialized = JSON.stringify({
			platform: options.platform,
			command: command,
			origin: source,
			time: options.now(),
			automatic: options.automaticState(),
			result: result === undefined ? null : result,
			error: error ? String(error.stack || error) : null
		}, null, 2);

		function write(title) {
			wiki.addTiddler(new Tiddler({
				title: title,
				type: "application/json",
				text: serialized
			}));
		}

		write(reportTitle);

		write(
			reportTitle + "/commands/" +
			encodeURIComponent(String(command))
		);

		if (source === "manual") {
			write(manualReportTitle);
		}

		publishAutomaticState();
	}

	return Object.freeze({
		reportTitle: reportTitle,
		manualReportTitle: manualReportTitle,
		automaticStateTitle: automaticStateTitle,
		publish: publish,
		publishAutomaticState: publishAutomaticState
	});
};