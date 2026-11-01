const $tw = require('tiddlywiki').TiddlyWiki();
$tw.boot.argv = ['wiki'];
$tw.boot.boot();

function runTests(name) {
	var report = $tw.modules.execute(`$:/plugins/clerus/core2/tests/${name}.js`).run($tw);
	console.table(report.results);

	if (!report.passed) {
		console.log(report.results.filter((test) => !test.passed));
	}
}

runTests("foundation");
runTests("scope");