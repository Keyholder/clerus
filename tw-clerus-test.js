const $tw = require('tiddlywiki').TiddlyWiki();
$tw.boot.argv = ['wiki'];
$tw.boot.boot();

$tw.modules.execute("$:/plugins/clerus/core/tests.js")
	.run($tw)
	.then(function (report) {
		console.table(report.results);

		if (!report.passed) {
			console.log(report.results.filter((test) => !test.passed));
		}
	});