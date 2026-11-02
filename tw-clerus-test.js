const $tw = require('tiddlywiki').TiddlyWiki();
$tw.boot.argv = ['wiki'];
$tw.boot.boot();

$tw.modules.execute("$:/plugins/clerus/core/tests.js")
	.run($tw)
	.then(function (report) {
		console.log({
			passed: report.passed,
			total: report.results.length,
			failed: report.results.filter(function (result) {
				return !result.passed;
			})
		});
	});