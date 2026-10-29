/*\
title: $:/plugins/clerus/core/ephemeral-writer.js
type: application/javascript
module-type: library
\*/

"use strict";

var states = require("$:/plugins/clerus/core/state.js");
var registryWriter =
	require("$:/plugins/clerus/core/registry-writer.js");

exports.createWriter = function (options) {
	return registryWriter.createWriter({
		state: states.live(options.wiki, options.Tiddler),
		job: options.job,
		platform: options.platform,
		Tiddler: options.Tiddler
	});
};