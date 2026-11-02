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
runTests("operations");
runTests("document-updates");
runTests("reaction");
runTests("observation");
runTests("integration");
runTests("mission-foundation");
runTests("hierarchy");
runTests("missions");
runTests("mission-issuance");
runTests("mission-scope");
runTests("project-perspective");
runTests("mission-reaction");
runTests("mission-mutations");
runTests("mission-transactions");
runTests("reports");
runTests("job-titles");
runTests("organization");
runTests("message-policy");
runTests("orders");
runTests("scheduler");