/*\
title: $:/plugins/clerus/core/management.js
type: application/javascript
module-type: library
\*/

"use strict";

var api = require("$:/plugins/clerus/core/api.js");
var stores = require("$:/plugins/clerus/core/store.js");
var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);

var DEMO_EXECUTOR = "$:/plugins/clerus/core/demo-executor.js";

function identitySource(tw) {
	if (tw.browser) {
		if (
			typeof window === "undefined" ||
			!window.crypto ||
			typeof window.crypto.getRandomValues !== "function"
		) {
			throw new Error("Clerus requires a cryptographic identity source");
		}

		return function () {
			var bytes = new Uint8Array(24);
			window.crypto.getRandomValues(bytes);

			return Array.prototype.map.call(bytes, function (value) {
				return value.toString(16).padStart(2, "0");
			}).join("");
		};
	}

	var crypto = require("crypto");

	return function () {
		return crypto.randomBytes(24).toString("hex");
	};
}

function create(options) {
	var tw = options.tw;
	var wiki = options.wiki;
	var platform = options.platform;
	var newId = options.newId || identitySource(tw);
	var schedule = options.schedule || function (callback) {
		return setTimeout(callback, 0);
	};

	var prefix = "$:/clerus/wal/" + platform + "/";
	var reportTitle = "$:/temp/clerus/management/" + platform;
	var busy = false;
	var scheduled = false;
	var started = false;
	var disposed = false;
	var baseline = null;

	function resolveExecutor(title) {
		var info = tw.modules.titles[title];

		if (!info || info.moduleType !== "clerus-executor") {
			return undefined;
		}

		var module = tw.modules.execute(title);

		return typeof module[platform] === "function"
			? module[platform]
			: undefined;
	}

	var runtime = api.create({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		newId: newId,
		resolveExecutor: resolveExecutor,
		autoCollectJobs: false
	});

	function walSignature() {
		var values = [];

		wiki.each(function (tiddler, title) {
			if (title.indexOf(prefix) === 0) {
				values.push([title, stores.capture(tiddler)]);
			}
		});

		values.sort(function (left, right) {
			return left[0] < right[0] ? -1
				: left[0] > right[0] ? 1 : 0;
		});

		return JSON.stringify(values);
	}

	function publish(command, result, error) {
		wiki.addTiddler(new tw.Tiddler({
			title: reportTitle,
			type: "application/json",
			text: JSON.stringify({
				platform: platform,
				command: command,
				result: result === undefined ? null : result,
				error: error ? String(error.stack || error) : null
			}, null, 2)
		}));
	}

	function service() {
		return {
			recovery: runtime.recover(),
			delivery: runtime.drainFlows()
		};
	}

	function prepareDemo() {
		var job = "$:/clerus/jobs/demo-" + newId();
		var journal = prefix + "demo-" + newId();

		if (
			wiki.tiddlerExists(job) ||
			wiki.isShadowTiddler(job) ||
			wiki.tiddlerExists(journal) ||
			wiki.isShadowTiddler(journal)
		) {
			throw new Error("Generated demonstration identity is occupied");
		}

		/*
		The event starts as an emission of accepted work.
		Recovery will register its fingerprint before publishing it
		as a waiting event.
		*/
		var record = continuations.validate({
			version: 2,
			kind: "continuation",
			platform: platform,
			work: {
				version: 2,
				id: newId(),
				checks: [],
				transitions: [],
				blocks: [],
				emits: [{
					id: newId(),
					event: {
						kind: "delivery",
						type: "order",
						establishing: true,
						recipient: {
							title: job,
							executor: DEMO_EXECUTOR
						},
						registry: {
							contract: {
								form: "contract",
								executor: DEMO_EXECUTOR,
								temp: false,
								book: { steps: 3 }
							}
						}
					}
				}]
			},
			events: {},
			evidence: {
				identities: {},
				receipts: {}
			},
			diagnostics: []
		}, platform, journal);

		wiki.addTiddler(new tw.Tiddler({
			title: journal,
			type: "application/json",
			"clerus-wal-kind": "continuation",
			"clerus-custody": "user",
			text: JSON.stringify(record, null, 2)
		}));

		return {
			journal: journal,
			job: job
		};
	}

	function changeCustody(title, custody) {
		if (
			typeof title !== "string" ||
			title.indexOf(prefix) !== 0 ||
			title.length === prefix.length
		) {
			throw new Error("Select a WAL belonging to this platform");
		}

		if (!wiki.tiddlerExists(title)) {
			throw new Error("WAL is not materialized");
		}

		var tiddler = wiki.getTiddler(title);

		if (tiddler.fields["clerus-wal-kind"] !== "continuation") {
			throw new Error("This control supports continuation WAL only");
		}

		if (custody === platform) {
			continuations.validate(
				JSON.parse(tiddler.fields.text),
				platform,
				title
			);
		}

		wiki.addTiddler(new tw.Tiddler(tiddler, {
			"clerus-custody": custody
		}));

		return {
			journal: title,
			custody: custody
		};
	}

	function command(name, title) {
		if (disposed) {
			throw new Error("Clerus management adapter is disposed");
		}

		if (busy) {
			throw new Error("Clerus management operation is already running");
		}

		busy = true;

		try {
			var result;

			switch (name) {
				case "service":
					result = service();
					break;

				case "deferred":
					result = runtime.runDeferred();
					break;

				case "observe":
					result = runtime.observe();
					break;

				case "inspect":
					result = runtime.inspect();
					break;

				case "demo":
					result = prepareDemo();
					break;

				case "release":
					result = changeCustody(title, platform);
					result.service = service();
					break;

				case "hold":
					result = changeCustody(title, "user");
					break;

				default:
					throw new Error("Unknown Clerus command: " + name);
			}

			publish(name, result, null);
			return result;
		} catch (error) {
			publish(name, null, error);
			throw error;
		} finally {
			/*
			Changes caused by this operation must not schedule
			the same WAL state for automatic service again.
			*/
			baseline = walSignature();
			busy = false;
		}
	}

	function requestService() {
		if (disposed || scheduled) {
			return;
		}

		scheduled = true;

		schedule(function () {
			scheduled = false;

			if (disposed) {
				return;
			}

			if (busy) {
				requestService();
				return;
			}

			if (walSignature() === baseline) {
				return;
			}

			try {
				command("service");
			} catch (error) {
				/*
				The command already published its diagnostic.
				Do not retry the same state in a hot loop.
				*/
			}
		});
	}

	function onChange(changes) {
		if (Object.keys(changes).some(function (title) {
			return title.indexOf(prefix) === 0;
		})) {
			requestService();
		}
	}

	function start() {
		if (started || disposed) {
			return;
		}

		started = true;
		wiki.addEventListener("change", onChange);

		try {
			command("service");
		} catch (error) {
			// The adapter remains available for inspection and repair.
		}
	}

	function dispose() {
		if (disposed) {
			return;
		}

		disposed = true;

		if (started) {
			wiki.removeEventListener("change", onChange);
		}
	}

	return Object.freeze({
		platform: platform,
		reportTitle: reportTitle,
		command: command,
		start: start,
		dispose: dispose
	});
}

exports.create = create;