/*\
title: $:/plugins/clerus/core/startup.js
type: application/javascript
module-type: startup
\*/

"use strict";

var Runtime = require("$:/plugins/clerus/core/runtime.js").Runtime;
var Dispatcher = require("$:/plugins/clerus/core/dispatcher.js").Dispatcher;

var createOpenRouterTransport =
	require("$:/plugins/clerus/core/openrouter-transport.js")
		.createTransport;

var createBrowserCredentialStore =
	require("$:/plugins/clerus/core/browser-credentials.js")
		.createStore;

function agentTransport() {
	if ($tw.browser) {
		var credentials = createBrowserCredentialStore(window);

		$tw.clerus.browserCredentials = credentials;

		if (
			typeof window.fetch !== "function" ||
			typeof window.AbortController !== "function"
		) {
			return undefined;
		}

		return createOpenRouterTransport({
			fetch: window.fetch.bind(window),
			AbortController: window.AbortController,
			getApiKey: credentials.getApiKey,
			timeoutMs: 300000
		});
	}

	if (
		typeof process === "undefined" ||
		!process.env.OPENROUTER_API_KEY
	) {
		return undefined;
	}

	var host = require("node:vm").runInThisContext(
		"({" +
			"fetch: globalThis.fetch," +
			"AbortController: globalThis.AbortController" +
		"})",
		{ filename: "clerus-host-network-primitives" }
	);

	if (
		typeof host.fetch !== "function" ||
		typeof host.AbortController !== "function"
	) {
		throw new Error(
			"Clerus OpenRouter transport requires Node.js with fetch and AbortController"
		);
	}

	return createOpenRouterTransport({
		fetch: host.fetch,
		AbortController: host.AbortController,
		getApiKey: function () {
			return process.env.OPENROUTER_API_KEY;
		}
	});
}

exports.name = "clerus-core";
exports.platforms = ["browser", "node"];
exports.after = ["load-modules"];
exports.synchronous = true;

exports.startup = function () {
	$tw.clerus = $tw.clerus || {};

	if ($tw.clerus.dispatcher) {
		$tw.clerus.dispatcher.stop();
	}

	if ($tw.clerus.core) {
		$tw.clerus.core.stop();
	}

	var runtime = new Runtime({
		wiki: $tw.wiki,
		platform: $tw.browser ? "browser" : "node"
	});

	var dispatcher = new Dispatcher({
		runtime: runtime,
		modules: $tw.modules,
		Wiki: $tw.Wiki,
		Tiddler: $tw.Tiddler,
		autoCollectJobs: true,
		agentTransport: agentTransport()
	});

	$tw.clerus.core = runtime;
	$tw.clerus.dispatcher = dispatcher;

	runtime.start();
	dispatcher.start();
};