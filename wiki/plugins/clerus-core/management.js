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

	var clock = options.now === undefined
		? Date.now
		: options.now;

	if (typeof clock !== "function") {
		throw new Error("Management clock must be a function");
	}

	var schedule = options.schedule || function (callback) {
		return setTimeout(callback, 0);
	};

	var setTimer = options.setTimer || function (callback, milliseconds) {
		return setTimeout(callback, milliseconds);
	};

	var clearTimer = options.clearTimer || function (handle) {
		clearTimeout(handle);
	};

	var setCleanupTimer = options.setCleanupTimer || function (
		callback,
		milliseconds
	) {
		return setTimeout(callback, milliseconds);
	};

	var clearCleanupTimer = options.clearCleanupTimer || function (handle) {
		clearTimeout(handle);
	};

	if (
		typeof setCleanupTimer !== "function" ||
		typeof clearCleanupTimer !== "function"
	) {
		throw new Error("Cleanup requires timer functions");
	}

	var setObservationTimer = options.setObservationTimer || function (
		callback,
		milliseconds
	) {
		return setTimeout(callback, milliseconds);
	};

	var clearObservationTimer =
		options.clearObservationTimer || function (handle) {
			clearTimeout(handle);
		};

	var observationDelay = options.observationDelay === undefined
		? 1000
		: options.observationDelay;

	if (
		!Number.isInteger(observationDelay) ||
		observationDelay < 100 ||
		observationDelay > 60000
	) {
		throw new Error(
			"Observation delay must be between 100 and 60000 milliseconds"
		);
	}

	if (
		typeof setObservationTimer !== "function" ||
		typeof clearObservationTimer !== "function"
	) {
		throw new Error("Observation requires timer functions");
	}

	var observationEnabled = false;
	var observationTimer = null;

	var automaticDelay = options.automaticDelay === undefined
		? 1000
		: options.automaticDelay;

	if (
		!Number.isInteger(automaticDelay) ||
		automaticDelay < 100 ||
		automaticDelay > 60000
	) {
		throw new Error(
			"Automatic pass delay must be between 100 and 60000 milliseconds"
		);
	}

	if (
		typeof setTimer !== "function" ||
		typeof clearTimer !== "function"
	) {
		throw new Error("Automatic passes require timer functions");
	}

	var automaticEnabled = false;
	var automaticTimer = null;
	var prefix = "$:/clerus/wal/" + platform + "/";

	var reports = require(
		"$:/plugins/clerus/core/management-reports.js"
	).create({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		now: clock,
		automaticState: automaticState
	});

	var publish = reports.publish;
	var publishAutomaticState = reports.publishAutomaticState;
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

	var prototypeWalReceipts = options.prototypeWalReceipts !== false;
	var cleanupTimer = null;

	var runtime = api.create({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		newId: newId,
		resolveExecutor: resolveExecutor,
		autoCollectJobs: false,

		continuationRetention: prototypeWalReceipts
			? {
				delay: 150000,
				now: clock
			}
			: undefined
	});

	var receiptHeuristic = prototypeWalReceipts
		? require(
			"$:/plugins/clerus/core/prototype-wal-receipts.js"
		).create({
			wiki: wiki,
			platform: platform,
			recordWalDeletion: runtime.recordWalDeletion,
			now: clock
		})
		: null;

	var workPublisher = require(
		"$:/plugins/clerus/core/management-work.js"
	).create({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		now: clock,
		prototypeWalReceipts: prototypeWalReceipts
	});

	var projectDemo = require(
		"$:/plugins/clerus/core/project-demo-management.js"
	).create({
		wiki: wiki,
		Tiddler: tw.Tiddler,
		platform: platform,
		newId: newId,
		publisher: workPublisher
	});

	function walSignature() {
		var values = [];

		wiki.each(function (tiddler, title) {
			var relevant = prototypeWalReceipts
				? (
					title.indexOf("$:/clerus/wal/") === 0 ||
					title.indexOf("$:/clerus/jobs/") === 0
				)
				: title.indexOf(prefix) === 0;

			if (relevant) {
				values.push([title, stores.capture(tiddler)]);
			}
		});

		values.sort(function (left, right) {
			return left[0] < right[0] ? -1
				: left[0] > right[0] ? 1 : 0;
		});

		return JSON.stringify(values);
	}

	function service() {
		var receipts = receiptHeuristic
			? receiptHeuristic.scan()
			: null;

		return {
			prototypeReceipts: receipts,
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

		var initial = {
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
		};

		if (prototypeWalReceipts) {
			initial.retainUntil = clock() + 150000;
		}

		var record = continuations.validate(
			initial,
			platform,
			journal
		);

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

	function retryEvent(title, eventId) {
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

		if (
			tiddler.fields.type !== "application/json" ||
			tiddler.fields["clerus-wal-kind"] !== "continuation" ||
			tiddler.fields["clerus-custody"] !== "user"
		) {
			throw new Error(
				"Event repair requires a continuation under user custody"
			);
		}

		var record = continuations.validate(
			JSON.parse(tiddler.fields.text),
			platform,
			title
		);

		if (record.work !== null) {
			throw new Error(
				"Cannot retry an event during active materialization"
			);
		}

		if (
			typeof eventId !== "string" ||
			!Object.prototype.hasOwnProperty.call(record.events, eventId) ||
			record.events[eventId].mode !== "paused"
		) {
			throw new Error("Select a paused event");
		}

		record.events[eventId].mode = "ready";

		record = continuations.validate(record, platform, title);

		wiki.addTiddler(new tw.Tiddler(tiddler, {
			text: JSON.stringify(record, null, 2)
		}));

		return {
			journal: title,
			eventId: eventId,
			mode: "ready",
			custody: "user"
		};
	}

	function resumeJob(title) {
		if (
			typeof title !== "string" ||
			title.indexOf("$:/clerus/jobs/") !== 0 ||
			title.length === "$:/clerus/jobs/".length
		) {
			throw new Error("Select a persistent job");
		}

		if (!wiki.tiddlerExists(title)) {
			throw new Error("Job is not materialized");
		}

		var tiddler = wiki.getTiddler(title);
		var fields = tiddler.fields;

		if (
			fields.type !== "application/json" ||
			typeof fields["clerus-executor"] !== "string" ||
			fields["clerus-executor"].length === 0 ||
			fields["clerus-suspended"] !== "yes"
		) {
			throw new Error("Select a suspended persistent job");
		}

		if (fields["clerus-custody-transfer"] !== undefined) {
			throw new Error(
				"This control does not support jobs with custody-transfer markers"
			);
		}

		if (
			fields["clerus-custody"] !== "user" &&
			fields["clerus-custody"] !== platform
		) {
			throw new Error("Cannot resume a job owned by another platform");
		}

		if (
			typeof resolveExecutor(fields["clerus-executor"]) !==
				"function"
		) {
			throw new Error("Executor is unavailable on this platform");
		}

		if (fields["clerus-custody"] === "user") {
			wiki.addTiddler(new tw.Tiddler(tiddler, {
				"clerus-custody": platform
			}));
		}

		/*
		Custody transfer above is an explicit administrative edit.
		It is not rolled back if resumption fails or remains blocked.
		The runtime owns the resumption protocol and diagnostics.
		*/
		return runtime.resume(title);
	}

	function automaticState() {
		return {
			enabled: automaticEnabled,
			delay: automaticDelay,
			observationEnabled: observationEnabled,
			observationDelay: observationDelay
		};
	}

	function stopAutomatic(publishState) {
		automaticEnabled = false;

		if (automaticTimer !== null) {
			clearTimer(automaticTimer);
			automaticTimer = null;
		}

		if (publishState !== false) {
			publishAutomaticState();
		}

		return automaticState();
	}

	function scheduleAutomatic() {
		if (
			disposed ||
			!automaticEnabled ||
			automaticTimer !== null
		) {
			return;
		}

		automaticTimer = setTimer(function () {
			automaticTimer = null;

			if (disposed || !automaticEnabled) {
				return;
			}

			if (busy) {
				scheduleAutomatic();
				return;
			}

			try {
				command(
					"deferred",
					undefined,
					undefined,
					"automatic"
				);
			} catch (error) {
				/*
				An uncaught adapter/runtime exception stops the
				automatic driver. Existing obligations remain.
				*/
				stopAutomatic();
				publish(
					"automatic-stopped",
					null,
					error,
					"automatic"
				);
				return;
			}

			/*
			Newly scheduled activations can run only in a later
			pass, after another full timer interval.
			*/
			scheduleAutomatic();
		}, automaticDelay);
	}

	function startAutomatic() {
		automaticEnabled = true;
		scheduleAutomatic();
		publishAutomaticState();

		return automaticState();
	}

	function prepareMove(title) {
		if (
			typeof title !== "string" ||
			title.indexOf("$:/clerus/jobs/") !== 0 ||
			title.length === "$:/clerus/jobs/".length
		) {
			throw new Error("Select a persistent job");
		}

		var store = new stores.Store({
			wiki: wiki,
			Tiddler: tw.Tiddler
		});

		var current = store.read(title);

		if (current.kind !== "materialized") {
			throw new Error("Job is not materialized");
		}

		var before = current.fields;

		if (
			before.type !== "application/json" ||
			typeof before["clerus-executor"] !== "string" ||
			before["clerus-executor"].length === 0
		) {
			throw new Error("Invalid job header");
		}

		if (before["clerus-suspended"] === "yes") {
			throw new Error("Resume the suspended job before moving it");
		}

		var custody = require(
			"$:/plugins/clerus/core/local-custody.js"
		).create({
			store: store,
			platform: platform
		});

		if (!custody.owns(before)) {
			throw new Error("Job is not locally owned");
		}

		var destination = platform === "browser"
			? "node"
			: "browser";

		var journal = prefix + "move-" + newId();
		var workId = newId();

		if (store.read(journal).kind !== "absent") {
			throw new Error("Generated move journal title is occupied");
		}

		var marker = {
			version: 1,
			journal: journal,
			work: workId,
			from: platform,
			to: destination
		};

		var record = {
			version: 2,
			kind: "continuation",
			platform: platform,
			work: null,
			events: {},
			evidence: {
				identities: {},
				receipts: {}
			},
			diagnostics: []
		};

		if (prototypeWalReceipts) {
			record.retainUntil = clock() + 150000;
			marker.retainUntil = record.retainUntil;
		}

		var after = Object.assign({}, before, {
			"clerus-custody": destination,
			"clerus-custody-transfer": JSON.stringify(marker)
		});

		record.work = {
			version: 2,
			id: workId,
			checks: [],
			transitions: [
				stores.transition(title, before, after)
			],
			blocks: [],
			emits: []
		};

		workPublisher.publishRecord(record, journal);

		return {
			journal: journal,
			job: title,
			from: platform,
			to: destination,
			retainUntil: record.retainUntil === undefined
				? null
				: record.retainUntil
		};
	}

	function stopObservation(publishState) {
		observationEnabled = false;

		if (observationTimer !== null) {
			clearObservationTimer(observationTimer);
			observationTimer = null;
		}

		if (publishState !== false) {
			publishAutomaticState();
		}

		return automaticState();
	}

	function scheduleObservation() {
		if (
			disposed ||
			!observationEnabled ||
			observationTimer !== null
		) {
			return;
		}

		observationTimer = setObservationTimer(function () {
			observationTimer = null;

			if (disposed || !observationEnabled) {
				return;
			}

			if (busy) {
				scheduleObservation();
				return;
			}

			try {
				command(
					"observe",
					undefined,
					undefined,
					"automatic-observation"
				);
			} catch (error) {
				stopObservation();

				publish(
					"observation-stopped",
					null,
					error,
					"automatic-observation"
				);

				return;
			}

			scheduleObservation();
		}, observationDelay);
	}

	function startObservation() {
		observationEnabled = true;
		scheduleObservation();
		publishAutomaticState();

		return automaticState();
	}

	function command(name, title, eventId, origin) {
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

				case "observation-status":
					result = runtime.observationStatus();
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

				case "retry":
					result = retryEvent(title, eventId);
					break;

				case "terminate":
					result = runtime.terminateEvent(title, eventId);
					break;

				case "resume":
					result = resumeJob(title);
					break;

				case "automatic-start":
					result = startAutomatic();
					break;

				case "automatic-stop":
					result = stopAutomatic();
					break;

				case "prepare-move":
					result = prepareMove(title);
					break;

				case "project-demo":
					result = projectDemo.prepare();
					break;

				case "project-resources":
					result = projectDemo.resources(title);
					break;

				case "project-close":
					result = projectDemo.close(title);
					break;

				case "collect":
					result = runtime.collect();
					break;

				case "observation-start":
					result = startObservation();
					break;

				case "observation-stop":
					result = stopObservation();
					break;

				default:
					throw new Error("Unknown Clerus command: " + name);
			}

			publish(name, result, null, origin);
			return result;
		} catch (error) {
			publish(name, null, error, origin);
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
				command(
					"service",
					undefined,
					undefined,
					"wiki-change"
				);
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
			return prototypeWalReceipts
				? (
					title.indexOf("$:/clerus/wal/") === 0 ||
					title.indexOf("$:/clerus/jobs/") === 0
				)
				: title.indexOf(prefix) === 0;
		})) {
			requestService();
		}
	}

	function hasExpiredWal() {
		var expired = false;
		var timestamp = clock();

		wiki.each(function (tiddler, title) {
			if (
				title.indexOf(prefix) !== 0 ||
				tiddler.fields["clerus-custody"] !== platform ||
				tiddler.fields["clerus-wal-kind"] !== "continuation"
			) {
				return;
			}

			try {
				var record = continuations.validate(
					JSON.parse(tiddler.fields.text),
					platform,
					title
				);

				if (
					record.work === null &&
					Object.keys(record.events).length === 0 &&
					record.retainUntil !== undefined &&
					record.retainUntil <= timestamp
				) {
					expired = true;
				}
			} catch (error) {
				// A malformed WAL is not a deletion candidate.
			}
		});

		return expired;
	}

	function scheduleCleanup() {
		if (
			!prototypeWalReceipts ||
			disposed ||
			cleanupTimer !== null
		) {
			return;
		}

		cleanupTimer = setCleanupTimer(function () {
			cleanupTimer = null;

			if (disposed) {
				return;
			}

			try {
				if (!busy) {
					var receipts = receiptHeuristic.scan();

					if (receipts.errors.length > 0) {
						publish(
							"prototype-receipts",
							receipts,
							null,
							"maintenance"
						);
					}

					if (
						receipts.received.length > 0 ||
						hasExpiredWal()
					) {
						command(
							"service",
							undefined,
							undefined,
							"maintenance"
						);
					}
				}
			} catch (error) {
				publish(
					"prototype-maintenance",
					null,
					error,
					"maintenance"
				);
			} finally {
				scheduleCleanup();
			}
		}, 1000);
	}

	function start() {
		if (started || disposed) {
			return;
		}

		started = true;
		wiki.addEventListener("change", onChange);

		try {
			command(
				"service",
				undefined,
				undefined,
				"startup"
			);
		} catch (error) {
			// The adapter remains available for inspection and repair.
		}

		scheduleCleanup();
	}

	function dispose() {
		if (disposed) {
			return;
		}

		/*
		Disable re-entry and rescheduling before cleanup.
		Even a reporting failure must not leave a live adapter.
		*/
		disposed = true;

		if (cleanupTimer !== null) {
			clearCleanupTimer(cleanupTimer);
			cleanupTimer = null;
		}

		if (started) {
			wiki.removeEventListener("change", onChange);
		}

		stopAutomatic(false);
		stopObservation(false);
		publishAutomaticState();
	}

	return Object.freeze({
		platform: platform,
		reportTitle: reports.reportTitle,
		manualReportTitle: reports.manualReportTitle,
		automaticStateTitle: reports.automaticStateTitle,
		command: command,
		start: start,
		dispose: dispose
	});
}

exports.create = create;