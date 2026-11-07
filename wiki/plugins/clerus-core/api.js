/*\
title: $:/plugins/clerus/core/api.js
type: application/javascript
module-type: library
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;

/*
Public management entry point.

The internal Runtime remains available to infrastructure tests.
It is not exposed through the management object.
*/
function create(options) {
	var runtime = new Runtime(options);
	var api = Object.create(null);

	[
		"dispatch",
		"observe",
		"resetObservation",
		"runDeferred",
		"drainFlows",
		"recover",
		"resume",
		"collect",
		"inspect",
		"recordWalDeletion"
	].forEach(function (name) {
		Object.defineProperty(api, name, {
			value: runtime[name].bind(runtime),
			enumerable: true,
			writable: false,
			configurable: false
		});
	});

	return Object.freeze(api);
}

exports.create = create;