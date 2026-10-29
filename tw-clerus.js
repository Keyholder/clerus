require('node:http').setGlobalProxyFromEnv();
const $tw = require('tiddlywiki').TiddlyWiki();
$tw.boot.argv = ['wiki', '--listen'];
$tw.boot.boot();