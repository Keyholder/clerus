/*\
title: $:/plugins/clerus/tests/startup.js
type: application/javascript
module-type: startup
\*/

"use strict";

exports.name = "clerus-test-controls";
exports.after = ["startup"];
exports.before = ["render"];
exports.synchronous = true;

exports.startup = function () {
	var running = false;
	var title = "$:/temp/clerus/tests/report";

	function write(value) {
		$tw.wiki.addTiddler(new $tw.Tiddler({
			title: title,
			type: "application/json",
			text: JSON.stringify(value, null, 2)
		}));
	}

	$tw.rootWidget.addEventListener(
		"tm-clerus-tests",
		function (event) {
			if (running) {
				return false;
			}

			var parameters = event.paramObject || {};
			var selection = parameters.suite
				? { suites: [parameters.suite] }
				: undefined;

			running = true;
			write({ status: "running" });

			/*
			Yield before starting the suites so the browser can
			display the running state.
			*/
			setTimeout(function () {
				Promise.resolve().then(function () {
					return require(
						"$:/plugins/clerus/tests/core.js"
					).run($tw, selection);
				}).then(function (report) {
					write({
						status: "completed",
						passed: report.passed,
						total: report.results.length,
						failed: report.results.filter(function (result) {
							return !result.passed;
						}),
						suites: report.suites
					});
				}).catch(function (error) {
					write({
						status: "failed",
						error: String(error.stack || error)
					});
				}).then(function () {
					running = false;
				});
			}, 0);

			return false;
		}
	);
};