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
runTests("document-updates");
runTests("reaction");
runTests("observation");
runTests("integration");
runTests("mission-foundation");
runTests("hierarchy");
runTests("missions");
runTests("mission-issuance");
runTests("project-perspective");
runTests("mission-reaction");
runTests("mission-mutations");
runTests("mission-transactions");
runTests("mission-scope");
runTests("reports");
runTests("mission-delivery");
runTests("mission-delivery-boundaries");
runTests("job-titles");
runTests("organization");
runTests("operations");
runTests("orders");
runTests("scheduler");
runTests("lifecycle");
runTests("scheduler-lifecycle");
runTests("runtime");
runTests("message-policy");
runTests("establishment-reaction");
runTests("establishment-delivery");
runTests("assigned-establishment");
runTests("title-issuance");
runTests("contracts");
runTests("establishment-scope");