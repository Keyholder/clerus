/*\
title: $:/plugins/clerus/core/dispatcher.js
type: application/javascript
module-type: library
\*/

"use strict";

var contexts = require("$:/plugins/clerus/core/context.js");
var createWriter =
	require("$:/plugins/clerus/core/ephemeral-writer.js").createWriter;
var lifecycle = require("$:/plugins/clerus/core/lifecycle.js");
var jobViews = require("$:/plugins/clerus/core/job-view.js");
var StatusObserver =
	require("$:/plugins/clerus/core/status-observer.js").StatusObserver;
var hierarchy = require("$:/plugins/clerus/core/hierarchy.js");
var missions = require("$:/plugins/clerus/core/missions.js");
var projectWriter =
	require("$:/plugins/clerus/core/project-writer.js");
var roles = require("$:/plugins/clerus/core/roles.js");
var detachment = require("$:/plugins/clerus/core/detachment.js");
var establishment =
	require("$:/plugins/clerus/core/establishment.js");
var reporting = require("$:/plugins/clerus/core/reporting.js");
var documentFlow =
	require("$:/plugins/clerus/core/document-flow.js");
var reportAddress =
	require("$:/plugins/clerus/core/report-address.js");
var tiddlerViews =
	require("$:/plugins/clerus/core/tiddler-view.js");
var filterViews =
	require("$:/plugins/clerus/core/filter-view.js");
var filterWriter =
	require("$:/plugins/clerus/core/filter-writer.js");
var tiddlerWriter =
	require("$:/plugins/clerus/core/tiddler-writer.js");
var tiddlerCreation =
	require("$:/plugins/clerus/core/tiddler-creation.js");
var states = require("$:/plugins/clerus/core/state.js");
var registryWriter =
	require("$:/plugins/clerus/core/registry-writer.js");
var WorkPlan =
	require("$:/plugins/clerus/core/work-plan.js").WorkPlan;
var Wal = require("$:/plugins/clerus/core/wal.js").Wal;
var missionPerspective =
	require("$:/plugins/clerus/core/mission-perspective.js");
var FlowWal =
	require("$:/plugins/clerus/core/flow-wal.js").FlowWal;
var messageEffects =
	require("$:/plugins/clerus/core/message-effect.js");
var deferredEffects =
	require("$:/plugins/clerus/core/deferred-effect.js");
var deferredWal =
	require("$:/plugins/clerus/core/deferred-wal.js");
var appointmentEffects =
	require("$:/plugins/clerus/core/appointment-effect.js");
var missionIssuance =
	require("$:/plugins/clerus/core/mission-issuance.js");
var missionTransfer =
	require("$:/plugins/clerus/core/mission-transfer.js");
var materializationBarrier =
	require("$:/plugins/clerus/core/materialization-barrier.js");
var AgentCallDriver =
	require("$:/plugins/clerus/core/agent-call-driver.js").Driver;
var jobCollection =
	require("$:/plugins/clerus/core/job-collection.js");

function loadExecutors(modules) {
	var executors = new Map();

	modules.forEachModuleOfType("clerus-executor", function (title, exports) {
		if (typeof exports.name !== "string" || !exports.name) {
			throw new Error("Executor must declare a name: " + title);
		}

		if (executors.has(exports.name)) {
			throw new Error("Duplicate executor: " + exports.name);
		}

		executors.set(exports.name, exports);
	});

	return executors;
}

function Dispatcher(options) {
	this.runtime = options.runtime;
	this.forms = contexts.loadForms(options.modules);
	this.executors = loadExecutors(options.modules);
	this.documentRules = documentFlow.loadRules(options.modules);
	this.Wiki = options.Wiki;
	this.Tiddler = options.Tiddler;
    this.observer = new StatusObserver();
	this.activations = new Map();
	this.errors = new Map();
	this.pendingOrders = new Map();
	this.deferred = new Map();
	this.deferredEvents = new Map();
	this.deferredTimers = new Map();
	this.orders = [];
	this.orderTimer = null;
	this.autoCollectJobs = options.autoCollectJobs === true;
	this.collection = null;

	this.wal = new Wal({
		wiki: this.runtime.wiki,
		Tiddler: this.Tiddler,
		platform: this.runtime.platform
	});

	this.recovery = [];

	this.flowWal = new FlowWal({
		wiki: this.runtime.wiki,
		Tiddler: this.Tiddler,
		platform: this.runtime.platform
	});

	this.flowMessages = new Map();
	this.flowRecovery = [];

	this.agentCalls = options.agentTransport
		? new AgentCallDriver({
			dispatcher: this,
			transport: options.agentTransport
		})
		: null;

	this.messageSession =
		"m-" + Date.now().toString(36) + "-" +
		Math.random().toString(36).slice(2);

	this.messageSequence = 0;
	this.reactionDepth = 0;
	this.started = false;
	this.onChange = this.scan.bind(this);
}

Dispatcher.prototype.establish = function (
	source,
	replace,
	contractKey,
	target,
	contract,
	transferredMission,
	titleCopies
) {
	if (
		typeof contract.executor !== "string" ||
		!contract.executor
	) {
		throw new Error("Contract must name an executor");
	}

	var executor = this.executors.get(contract.executor);

	if (!executor || typeof executor[this.runtime.platform] !== "function") {
		throw new Error("Executor is unavailable on this platform");
	}

	if (this.pendingOrders.has(target)) {
		throw new Error("Recipient already has a pending establishing order");
	}

	this.pendingOrders.set(target, {
		executor: contract.executor
	});

	try {
		var result = establishment.establish({
			runtime: this.runtime,
			Tiddler: this.Tiddler,
			rules: this.documentRules,
			source: source,
			replace: replace,
			contractKey: contractKey,
			target: target,
			contract: contract,
			transferredMission: transferredMission,
			titleCopies: titleCopies
		});

		return result;
	} catch (error) {
		this.pendingOrders.delete(target);
		throw error;
	}
};

Dispatcher.prototype.insertTitle = function (
	job,
	replace,
	key,
	title,
	state
) {
	state = state || states.live(this.runtime.wiki, this.Tiddler);

	if (job.persistent && state.mode !== "planned") {
		throw new Error("Persistent document creation requires a work plan");
	}

	if (
		typeof title !== "string" ||
		title.indexOf(job.title + "/") !== 0
	) {
		throw new Error("New title must extend the current job title");
	}

	var real = this.runtime.inspect().jobs.find(function (candidate) {
		return candidate.title === job.title;
	});

	if (
		!real ||
		!real.valid ||
		!real.local ||
		!real.owned ||
		real.executor !== job.executor
	) {
		throw new Error("Source job is no longer eligible");
	}

	var jobs = missionPerspective.jobs(
		this.runtime,
		state,
		job.title
	);

	var source = jobs.find(function (candidate) {
		return candidate.title === job.title;
	});

	if (!source || !source.valid || !source.local || !source.owned) {
		throw new Error("Source job is no longer eligible");
	}

	if (Object.prototype.hasOwnProperty.call(source.registry, key)) {
		throw new Error("Document key already exists: " + key);
	}

	// inspect() returns copies, so this modifies only the candidate graph.
	Object.defineProperty(source.registry, key, {
		value: title,
		enumerable: true,
		writable: true,
		configurable: true
	});

	var report = hierarchy.audit(jobs);

	if (!report.valid || !report.complete) {
		throw new Error("New title would enter an invalid hierarchy");
	}

	replace(key, title, {
		insert: true
	});
};

Dispatcher.prototype.readMission = function (
	holder,
	document,
	wiki,
	state
) {
	return missions.read(
		wiki || this.runtime.wiki,
		missionPerspective.jobs(this.runtime, state, holder),
		holder,
		document
	);
};

Dispatcher.prototype.prepareMissionMutation = function (
	job,
	key,
	document,
	state,
	requireActive
) {
	var real = this.runtime.inspect().jobs.find(function (candidate) {
		return candidate.title === job.title;
	});

	if (
		!real ||
		!real.valid ||
		!real.local ||
		!real.owned ||
		real.executor !== job.executor
	) {
		throw new Error("Mission owner is no longer authorized");
	}

	var tiddler = state.getTiddler(job.title);

	if (!tiddler) {
		throw new Error("Mission owner is absent from operation state");
	}

	var registry = JSON.parse(tiddler.fields.text);

	if (
		!missions.isMission(document) ||
		JSON.stringify(registry[key]) !== JSON.stringify(document)
	) {
		throw new Error("Mission document has changed");
	}

	var jobs = missionPerspective.jobs(
		this.runtime,
		state,
		job.title
	);

	var view = missions.read(
		{ getTiddler: state.getTiddler },
		jobs,
		job.title,
		document
	);

	if (requireActive && !view.active) {
		throw new Error("Inactive mission cannot modify bindings");
	}

	return {
		registry: registry,
		jobs: jobs
	};
};

Dispatcher.prototype.createMission = function (
	job,
	replace,
	parentKey,
	parentDocument,
	segment,
	destinationKey,
	state
) {
	state = state || states.live(this.runtime.wiki, this.Tiddler);

	var prepared = this.prepareMissionMutation(
		job,
		parentKey,
		parentDocument,
		state,
		true
	);

	if (!roles.isSegment(segment)) {
		throw new Error("Invalid child role segment");
	}

	var project = state.getTiddler(parentDocument.project);

	if (
		!project ||
		project.fields["clerus-custody"] !== this.runtime.platform
	) {
		throw new Error("Project is not owned by this platform");
	}

	missions.resolveNode(
		JSON.parse(project.fields.text),
		parentDocument.role.concat([segment])
	);

	var result = missionIssuance.issue(
		prepared.registry,
		parentKey,
		segment,
		destinationKey
	);

	replace.replaceAll(result.registry);

	return result;
};

Dispatcher.prototype.defer = function (source) {
	if (source.persistent) {
		throw new Error("Persistent deferred events require a work plan");
	}

	if (this.deferred.has(source.title)) {
		return;
	}

	var timer = setTimeout(function () {
		this.deferred.delete(source.title);

		if (!this.started) {
			return;
		}

		var job = this.runtime.inspect().jobs.find(function (candidate) {
			return candidate.title === source.title;
		});

		if (
			!job ||
			!job.valid ||
			!job.local ||
			!job.owned ||
			job.persistent ||
			job.executor !== source.executor ||
			this.activations.get(job.title) !== job.executor
		) {
			return;
		}

		var executor = this.executors.get(job.executor);
		var handler = executor && executor[this.runtime.platform];

		if (typeof handler === "function") {
			this.invoke(job, handler, {
				type: "tick"
			});

			if (this.autoCollectJobs) {
				this.scheduleOrders();
			}
		}
	}.bind(this), 0);

	this.deferred.set(source.title, timer);
};

Dispatcher.prototype.sendMemoReport = function (
	source,
	key,
	document,
	registry
) {
	var address = reportAddress.resolve({
		runtime: this.runtime,
		source: source,
		key: key,
		document: document
	});

	var executor = this.executors.get(address.recipient.executor);

	if (
		!executor ||
		typeof executor[this.runtime.platform] !== "function"
	) {
		throw new Error("Recipient executor is unavailable");
	}

	var delivery = documentFlow.prepare(
		registry,
		{
			type: "report",
			establishing: false
		},
		this.documentRules
	);

	if (
		Object.keys(delivery.automatic).length > 0 ||
		delivery.entries.some(function (entry) {
			return entry.transfer !== "copy";
		})
	) {
		throw new Error(
			"Memo reports support only explicitly received copies"
		);
	}

	this.orders.push({
		type: "report",
		target: address.recipient.title,
		executor: address.recipient.executor,
		role: address.role,
		registry: JSON.parse(JSON.stringify(delivery.registry))
	});

	this.scheduleOrders();
};

Dispatcher.prototype.suspend = function (
	job,
	handler,
	diagnostic,
	event
) {
	if (!diagnostic.walTitle) {
		try {
			diagnostic.walTitle = this.wal.recordIncident(
				job,
				event,
				{
					name: diagnostic.name,
					message: diagnostic.message,
					stack: diagnostic.stack,
					phase: diagnostic.phase
				}
			);
		} catch (error) {
			diagnostic.incidentError = lifecycle.describeError(error);
		}
	}

	var registry;

	try {
		registry = lifecycle.suspendPersistent({
			wiki: this.runtime.wiki,
			Tiddler: this.Tiddler,
			platform: this.runtime.platform,
			job: job,
			error: {
				name: diagnostic.name,
				message: diagnostic.message,
				stack: diagnostic.stack
			}
		});
	} catch (error) {
		diagnostic.transitionError = lifecycle.describeError(error);
		return;
	}

	this.activations.delete(job.title);

	this.invoke({
		title: job.title,
		executor: job.executor,
		persistent: true,
		registry: registry
	}, handler, {
		type: "suspended",
		readOnly: true,
		ignoreErrors: true
	});
};

Dispatcher.prototype.queueFlowMessages = function (title, messages) {
	messages.forEach(function (message) {
		messageEffects.validate(message);

		var key = JSON.stringify([title, message.id]);

		this.flowMessages.set(key, {
			walTitle: title,
			message: JSON.parse(JSON.stringify(message))
		});
	}, this);

	if (messages.length > 0) {
		this.scheduleOrders();
	}
};

Dispatcher.prototype.runFlow = function (title) {
	try {
		var before = this.flowWal.read(title).record.errors.length;
		var messages = this.flowWal.resume(title);

		this.collectDeferred();
		this.queueFlowMessages(title, messages);

		var current = this.runtime.wiki.getTiddler(title);

		if (current) {
			var record = JSON.parse(current.fields.text);

			if (record.errors.length > before) {
				var failure = record.errors[record.errors.length - 1].error;
				var error = new Error(failure.message);

				error.name = failure.name;
				error.walTitle = title;

				throw error;
			}
		}

		return messages;
	} catch (error) {
		error.walTitle = title;
		throw error;
	}
};

Dispatcher.prototype.planOrder = function (
	source,
	targetKey,
	target,
	registry,
	plan,
	state
) {
	var jobs = this.runtime.inspect().jobs;
	var sender = jobs.find(function (job) {
		return job.title === source.title;
	});
	var recipient = jobs.find(function (job) {
		return job.title === target;
	});

	if (
		!sender ||
		!sender.valid ||
		!sender.local ||
		!sender.owned ||
		sender.executor !== source.executor
	) {
		throw new Error("Sender is no longer authorized");
	}

	var operational = state.getTiddler(source.title);

	if (
		!operational ||
		JSON.parse(operational.fields.text)[targetKey] !== target
	) {
		throw new Error("Sender does not hold the recipient title");
	}

	if (
		!recipient ||
		!recipient.valid ||
		!recipient.local ||
		!recipient.owned ||
		!recipient.persistent
	) {
		throw new Error("Planned orders require an active local persistent recipient");
	}

	var executor = this.executors.get(recipient.executor);

	if (!executor || typeof executor[this.runtime.platform] !== "function") {
		throw new Error("Recipient executor is unavailable");
	}

	var graph = hierarchy.audit(
		missionPerspective.jobs(this.runtime, state, source.title)
	);

	if (!graph.valid || !graph.complete) {
		throw new Error("Cannot issue an order in an invalid hierarchy");
	}

	this.messageSequence++;

	var message = messageEffects.create({
		id: this.messageSession + "-" + this.messageSequence.toString(36),
		message: "order",
		source: {
			title: source.title,
			executor: source.executor,
			platform: this.runtime.platform
		},
		recipient: {
			title: recipient.title,
			executor: recipient.executor,
			platform: this.runtime.platform
		},
		registry: registry
	}, this.documentRules);

	plan.send(message);
};

Dispatcher.prototype.planDefer = function (job, plan) {
	var current = this.runtime.inspect().jobs.find(function (candidate) {
		return candidate.title === job.title;
	});

	if (
		!current ||
		!current.valid ||
		!current.owned ||
		!current.persistent ||
		current.executor !== job.executor
	) {
		throw new Error("Job is no longer authorized to defer");
	}

	this.messageSequence++;

	plan.defer(deferredEffects.create({
		id: this.messageSession + "-tick-" + this.messageSequence.toString(36),
		recipient: {
			title: job.title,
			executor: job.executor,
			platform: this.runtime.platform
		}
	}));
};

Dispatcher.prototype.collectDeferred = function () {
	deferredWal.pending(this.flowWal).forEach(function (item) {
		if (
			this.deferredEvents.has(item.title) ||
			this.deferredTimers.has(item.title)
		) {
			return;
		}

		var timer = setTimeout(function () {
			this.deferredTimers.delete(item.title);

			if (!this.started) {
				return;
			}

			this.deferredEvents.set(item.title, item);
			this.scan();
		}.bind(this), 0);

		this.deferredTimers.set(item.title, timer);
	}, this);
};

Dispatcher.prototype.deliverDeferred = function () {
	var batch = Array.from(this.deferredEvents.values());

	this.deferredEvents.clear();

	batch.forEach(function (item) {
		var loaded;

		try {
			loaded = deferredWal.read(this.flowWal, item.title);
		} catch (error) {
			return;
		}

		var effect = loaded.effect;
		var job = this.runtime.inspect().jobs.find(function (candidate) {
			return candidate.title === effect.recipient.title;
		});
		var executor = job && this.executors.get(job.executor);
		var handler = executor && executor[this.runtime.platform];

		if (
			!job ||
			!job.valid ||
			!job.local ||
			!job.owned ||
			!job.persistent ||
			job.executor !== effect.recipient.executor ||
			typeof handler !== "function"
		) {
			this.deferredEvents.set(item.title, item);
			return;
		}

		if (this.activations.get(job.title) !== job.executor) {
			this.deferredEvents.set(item.title, item);
			this.scheduleOrders();
			return;
		}

		this.invoke(job, handler, {
			type: "tick",
			id: effect.id,
			deferred: {
				title: item.title,
				id: effect.id
			}
		});
	}, this);
};

Dispatcher.prototype.planMemoReport = function (
	source,
	key,
	document,
	registry,
	plan,
	state
) {
	var address = reportAddress.resolve({
		runtime: this.runtime,
		source: source,
		key: key,
		document: document,
		state: state
	});

	var executor = this.executors.get(address.recipient.executor);

	if (
		!executor ||
		typeof executor[this.runtime.platform] !== "function"
	) {
		throw new Error("Recipient executor is unavailable");
	}

	this.messageSequence++;

	plan.send(messageEffects.create({
		id: this.messageSession + "-" + this.messageSequence.toString(36),
		message: "report",
		source: {
			title: source.title,
			executor: source.executor,
			platform: this.runtime.platform
		},
		recipient: {
			title: address.recipient.title,
			executor: address.recipient.executor,
			platform: this.runtime.platform
		},
		project: document.project,
		role: address.role,
		registry: registry
	}, this.documentRules));
};

Dispatcher.prototype.planAppointment = function (
	job,
	replace,
	contractKey,
	target,
	contract,
	transferredMission,
	titleCopies,
	plan,
	state
) {
	var current = this.runtime.inspect().jobs.find(function (candidate) {
		return candidate.title === job.title;
	});

	if (
		!current ||
		!current.valid ||
		!current.owned ||
		!current.persistent ||
		current.executor !== job.executor
	) {
		throw new Error("Appointment source is no longer authorized");
	}

	var operational = state.getTiddler(job.title);

	if (!operational) {
		throw new Error("Appointment source is absent from operation state");
	}

	var registry = JSON.parse(operational.fields.text);

	if (
		JSON.stringify(registry[contractKey]) !== JSON.stringify(contract) ||
		!Object.keys(registry).some(function (key) {
			return registry[key] === target;
		})
	) {
		throw new Error("Source no longer holds the contract or recipient title");
	}

	if (
		target.indexOf("$:/clerus/jobs/") !== 0 ||
		this.runtime.wiki.getTiddler(target) ||
		state.getTiddler(target)
	) {
		throw new Error("Persistent appointment target must be absent");
	}

	var executor = this.executors.get(contract.executor);

	if (!executor || typeof executor[this.runtime.platform] !== "function") {
		throw new Error("Executor is unavailable on this platform");
	}

	var jobs = missionPerspective.jobs(
		this.runtime,
		state,
		job.title
	);

	var sender = jobs.find(function (candidate) {
		return candidate.title === job.title;
	});

	var mission = null;
	var missionKeys = [];

	if (transferredMission) {
		var transfer = missionTransfer.prepareDownward(
			jobs,
			job.title,
			transferredMission
		);

		mission = transferredMission.document;
		missionKeys = transfer.keys;

		missionKeys.forEach(function (key) {
			delete sender.registry[key];
		});
	}

	this.messageSequence++;

	var options = {
		id: this.messageSession + "-appointment-" +
			this.messageSequence.toString(36),
		source: {
			title: job.title,
			executor: job.executor,
			platform: this.runtime.platform
		},
		recipient: {
			title: target,
			executor: contract.executor,
			platform: this.runtime.platform
		},
		contract: contract
	};

	if (mission) {
		options.mission = mission;
	}

	var copiedTitles = Object.create(null);

	(titleCopies || []).forEach(function (copy) {
		if (
			typeof copy.destinationKey !== "string" ||
			copy.destinationKey.length === 0 ||
			copy.destinationKey === "charter" ||
			copy.destinationKey === "mission" ||
			Object.prototype.hasOwnProperty.call(
				copiedTitles, copy.destinationKey
			) ||
			!jobViews.isJobTitle(copy.title) ||
			registry[copy.sourceKey] !== copy.title
		) {
			throw new Error("Invalid or changed appointment title selection");
		}

		Object.defineProperty(copiedTitles, copy.destinationKey, {
			value: copy.title,
			enumerable: true,
			writable: true,
			configurable: true
		});
	});

	options.titles = copiedTitles;

	var effect = appointmentEffects.create(options, this.documentRules);

	jobs.push({
		title: target,
		persistent: true,
		local: true,
		owned: true,
		valid: true,
		custody: this.runtime.platform,
		executor: contract.executor,
		registry: effect.registry
	});

	var graph = hierarchy.audit(jobs);

	if (
		!graph.valid ||
		!graph.complete ||
		!missions.audit(jobs).valid
	) {
		throw new Error("Appointment transfer would violate structural invariants");
	}

	plan.appoint(effect);

	try {
		replace(contractKey, undefined, {
			removeKeys: missionKeys
		});
	} catch (error) {
		plan.cancelAppointment(effect.id);
		throw error;
	}

	return {
		sourceRemovedKeys: [contractKey].concat(missionKeys)
	};
};

Dispatcher.prototype.returnMission = function (
	source,
	replace,
	key,
	document,
	destinationKey,
	titleCopies
) {
	var address = reportAddress.resolve({
		runtime: this.runtime,
		source: source,
		key: key,
		document: document
	});

	var executor = this.executors.get(address.recipient.executor);

	if (!executor || typeof executor[this.runtime.platform] !== "function") {
		throw new Error("Recipient executor is unavailable");
	}

	var result = reporting.report({
		runtime: this.runtime,
		Tiddler: this.Tiddler,
		rules: this.documentRules,
		source: source,
		replace: replace,
		key: key,
		document: document,
		destinationKey: destinationKey,
		titleCopies: titleCopies
	});

	this.orders.push({
		type: "report",
		target: result.recipient,
		executor: result.executor,
		project: result.project,
		role: result.role,
		registry: result.registry
	});

	this.scheduleOrders();

	return result;
};

Dispatcher.prototype.materializationBlockers = function (job) {
	if (!job.persistent) {
		return [];
	}

	return materializationBarrier.collect(
		this.runtime.wiki,
		this.runtime.platform
	).forJob(job.title);
};

Dispatcher.prototype.invoke = function (job, handler, options) {
	options = options || {};

	if (
		!options.readOnly &&
		this.materializationBlockers(job).length > 0
	) {
		return;
	}

	this.reactionDepth++;

	var eventType = options.type || "ready";
	var scope = null;
	var incomingScope = null;
	var plan = null;

	try {
		var writeState = states.live(
			this.runtime.wiki,
			this.Tiddler
		);

		if (job.persistent && !options.readOnly) {
			if (typeof this.Wiki !== "function") {
				throw new Error("Planned reactions require the Wiki constructor");
			}

			plan = new WorkPlan({
				wiki: this.runtime.wiki,
				Wiki: this.Wiki,
				Tiddler: this.Tiddler
			});

			writeState = states.planned(plan);
		}

		var contextOptions = {};
		contextOptions.title = job.title;

		contextOptions.readTiddler = function (title) {
			if (plan) {
				if (this.runtime.wiki.isShadowTiddler(title)) {
					throw new Error(
						"Shadow-backed reads are not supported in planned reactions"
					);
				}

				return tiddlerViews.read(plan.view, title);
			}

			return tiddlerViews.read(this.runtime.wiki, title);
		}.bind(this);

		contextOptions.filterTitles = function (document) {
			return filterViews.titles(this.runtime.wiki, document);
		}.bind(this);

		contextOptions.readJob = function (title) {
			return jobViews.readJob(this.runtime.wiki, title);
		}.bind(this);

		contextOptions.readMission = function (document) {
			if (plan) {
				if (
					missions.isMission(document) &&
					this.runtime.wiki.isShadowTiddler(document.project)
				) {
					throw new Error(
						"Shadow-backed projects are not supported in planned reads"
					);
				}

				return this.readMission(
					job.title,
					document,
					plan.view,
					writeState
				);
			}

			return this.readMission(job.title, document);
		}.bind(this);

		if (!options.readOnly) {
			contextOptions.replace = registryWriter.createWriter({
				state: writeState,
				job: job,
				platform: this.runtime.platform,
				Tiddler: this.Tiddler
			});

			contextOptions.insert = function (key, title) {
				this.insertTitle(
					job,
					contextOptions.replace,
					key,
					title,
					writeState
				);
			}.bind(this);

			contextOptions.issueTitle = function (
				key,
				document,
				title,
				destinationKey
			) {
				filterWriter.issueTitle({
					runtime: this.runtime,
					job: job,
					key: key,
					document: document,
					title: title,
					destinationKey: destinationKey,
					replace: contextOptions.replace
				});
			}.bind(this);

			contextOptions.createTiddler = function (
				warrantKey,
				warrant,
				templateName,
				parameters,
				destinationKey
			) {
				return tiddlerCreation.create({
					runtime: this.runtime,
					Tiddler: this.Tiddler,
					job: job,
					state: writeState,
					warrantKey: warrantKey,
					warrant: warrant,
					templateName: templateName,
					parameters: parameters,
					destinationKey: destinationKey,
					replace: contextOptions.replace
				});
			}.bind(this);

			contextOptions.writeTiddler = function (
				documentKey,
				title,
				warrantKey,
				warrant,
				operation,
				patch
			) {
				tiddlerWriter.write({
					runtime: this.runtime,
					Tiddler: this.Tiddler,
					job: job,
					state: writeState,
					documentKey: documentKey,
					title: title,
					warrantKey: warrantKey,
					warrant: warrant,
					operation: operation,
					patch: patch
				});
			}.bind(this);

			contextOptions.order = function (
				contractKey,
				target,
				contract,
				transferredMission,
				titleCopies
			) {
				if (plan) {
					return this.planAppointment(
						job,
						contextOptions.replace,
						contractKey,
						target,
						contract,
						transferredMission,
						titleCopies,
						plan,
						writeState
					);
				}

				return this.establish(
					job,
					contextOptions.replace,
					contractKey,
					target,
					contract,
					transferredMission,
					titleCopies
				);
			}.bind(this);

			contextOptions.sendOrder = function (
				targetKey,
				target,
				registry
			) {
				if (plan) {
					this.planOrder(
						job,
						targetKey,
						target,
						registry,
						plan,
						writeState
					);
				} else {
					this.sendOrder(job, targetKey, target, registry);
				}
			}.bind(this);

			contextOptions.createPart = function (
				key,
				document,
				segment,
				task
			) {
				projectWriter.createPart({
					runtime: this.runtime,
					Tiddler: this.Tiddler,
					job: job,
					state: writeState,
					key: key,
					document: document,
					segment: segment,
					task: task
				});
			}.bind(this);

			contextOptions.createMission = function (
				parentKey,
				parentDocument,
				segment,
				destinationKey
			) {
				return this.createMission(
					job,
					contextOptions.replace,
					parentKey,
					parentDocument,
					segment,
					destinationKey,
					writeState
				);
			}.bind(this);

			contextOptions.reportMemos = function (key, document, registry) {
				if (eventType === "order") {
					throw new Error("Cannot report while reacting to an order");
				}

				if (plan) {
					this.planMemoReport(
						job,
						key,
						document,
						registry,
						plan,
						writeState
					);
				} else {
					this.sendMemoReport(job, key, document, registry);
				}
			}.bind(this);

			contextOptions.returnMission = function (
				key,
				document,
				destinationKey,
				titleCopies
			) {
				if (eventType === "order") {
					throw new Error("Cannot report while reacting to an order");
				}

				if (plan) {
					throw new Error("Persistent assignment reports are not supported yet");
				}

				return this.returnMission(
					job,
					contextOptions.replace,
					key,
					document,
					destinationKey,
					titleCopies
				);
			}.bind(this);

			contextOptions.defer = function () {
				if (plan) {
					this.planDefer(job, plan);
				} else {
					this.defer(job);
				}
			}.bind(this);

			contextOptions.resign = function (key, document) {
				var prepared = this.prepareMissionMutation(
					job,
					key,
					document,
					writeState,
					false
				);

				var result = missionIssuance.drop(prepared.registry, key);

				contextOptions.replace.replaceAll(result.registry);

				return result;
			}.bind(this);

			contextOptions.revokePart = function (key, document, segment) {
				var prepared = this.prepareMissionMutation(
					job,
					key,
					document,
					writeState,
					true
				);

				var result = missionIssuance.revoke(
					prepared.registry,
					key,
					segment
				);

				contextOptions.replace.replaceAll(result.registry);

				return result;
			}.bind(this);
		}

		if (plan) {
			contextOptions.atomicRegistryUpdates = true;

			contextOptions.allowedForms = [
				"charter",
				"memo",
				"tiddler-title",
				"job-title",
				"mission",
				"warrant",
				"agent-call",
				"agent-session"
			];
		}

		scope = contexts.openContext(
			job.registry,
			this.forms,
			contextOptions
		);

		if (options.registry !== undefined) {
			incomingScope = contexts.openContext(
				options.registry,
				this.forms,
				{
					readTiddler: contextOptions.readTiddler,
					filterTitles: contextOptions.filterTitles,
					readJob: contextOptions.readJob,
					readMission: contextOptions.readMission,

					file: function (key, document) {
						return scope.acceptMemo(key, document);
					}
				}
			);
		}

		var result = handler(
			Object.freeze({
				type: eventType,
				title: job.title,
				platform: this.runtime.platform,
				key: options.key,
				target: options.target,
				id: options.id,
				project: options.project,

				keys: options.keys
					? Object.freeze(options.keys.slice())
					: undefined,

				role: options.role
					? Object.freeze(options.role.slice())
					: undefined,

				roles: options.roles
					? Object.freeze(options.roles.map(function (item) {
						return Object.freeze({
							project: item.project,
							role: Object.freeze(item.role.slice())
						});
					}))
					: undefined
			}),
			scope.context,
			incomingScope ? incomingScope.context : null
		);

		if (
			result !== null &&
			result !== undefined &&
			typeof result.then === "function"
		) {
			throw new Error("Executor reactions must be synchronous");
		}

		if (
			plan &&
			(
				options.appointmentStart ||
				(
					eventType === "resumed" &&
					plan.view.getTiddler(job.title)
						.fields["clerus-start"]
				)
			)
		) {
			plan.patch(job.title, {
				"clerus-start": undefined
			});
		}

		if (plan) {
			if (incomingScope) {
				incomingScope.close();
				incomingScope = null;
			}

			if (scope) {
				scope.close();
				scope = null;
			}

			plan.commit(function (compiled) {
				var baseline = plan.initial(job.title);

				if (options.deferred) {
					deferredWal.accept(
						this.flowWal,
						options.deferred.title,
						options.deferred.id,
						job,
						baseline,
						compiled
					);

					return this.runFlow(options.deferred.title);
				}

				if (options.flow) {
					var accepted = this.flowWal.accept(
						options.flow.title,
						options.flow.messageId,
						job,
						baseline,
						compiled
					);

					if (accepted !== "accepted") {
						throw new Error("Flow message is no longer pending");
					}

					return this.runFlow(options.flow.title);
				}

				if (
					compiled.messages.length > 0 ||
					compiled.deferred.length > 0 ||
					compiled.appointments.length > 0
				) {
					var title = this.flowWal.register(
						job,
						baseline,
						compiled
					);

					return this.runFlow(title);
				}

				return this.wal.commit(job, compiled, {
					ownerState: baseline
				});
			}.bind(this));
		}

		if (
			job.persistent &&
			!options.readOnly &&
			eventType === "resumed"
		) {
			lifecycle.acknowledgeResumption({
				wiki: this.runtime.wiki,
				Tiddler: this.Tiddler,
				platform: this.runtime.platform,
				job: job
			});
		}

		if (!options.ignoreErrors) {
			this.errors.delete(job.title);
		}
	} catch (error) {
		if (!options.ignoreErrors) {
			var diagnostic = lifecycle.describeError(error);

			diagnostic.title = job.title;
			diagnostic.event = eventType;

			if (error && error.walTitle) {
				diagnostic.walTitle = error.walTitle;
			}

			this.errors.set(job.title, diagnostic);

			if (incomingScope) {
				incomingScope.close();
				incomingScope = null;
			}

			// Close the failing context before the lifecycle transition.
			if (scope) {
				scope.close();
				scope = null;
			}

			if (plan) {
				if (plan.state === "open") {
					plan.abort();
					diagnostic.phase = "reaction";
				} else if (plan.state === "failed") {
					diagnostic.phase = "commit";
					diagnostic.workPlan = plan.export();
				} else if (plan.state === "materialized") {
					diagnostic.phase = "lifecycle";
				}
			}

			if (plan && plan.state === "failed") {
				// The commit procedure failed. An accepted plan may
				// already exist and may be partially materialized.
				//
				// Do not rewrite the owner through suspension and
				// do not turn the incoming event into a branch failure.
				//
				// Existing WAL records provide the persistent barrier.
				return;
			}

			if (
				options.flow &&
				(!plan || plan.state === "aborted")
			) {
				try {
					var remaining = this.flowWal.failMessage(
						options.flow.title,
						options.flow.messageId,
						job,
						{
							name: diagnostic.name,
							message: diagnostic.message,
							stack: diagnostic.stack,
							phase: diagnostic.phase
						}
					);

					diagnostic.walTitle = options.flow.title;

					this.queueFlowMessages(
						options.flow.title,
						remaining
					);
				} catch (error) {
					diagnostic.branchError = lifecycle.describeError(error);
				}
			}

			if (
				options.deferred &&
				(!plan || plan.state === "aborted")
			) {
				try {
					deferredWal.fail(
						this.flowWal,
						options.deferred.title,
						options.deferred.id,
						job,
						{
							name: diagnostic.name,
							message: diagnostic.message,
							stack: diagnostic.stack,
							phase: diagnostic.phase
						}
					);

					diagnostic.walTitle = options.deferred.title;
				} catch (error) {
					diagnostic.branchError = lifecycle.describeError(error);
				}
			}

			if (!options.readOnly) {
				if (job.persistent) {
					this.suspend(job, handler, diagnostic, {
						type: eventType,
						role: options.role,
						key: options.key,
						target: options.target
					});
				} else {
					this.dismiss(job, handler, diagnostic);
				}
			}
		}
	} finally {
		try {
			if (incomingScope) {
				incomingScope.close();
			}

			if (scope) {
				scope.close();
			}
		} finally {
			this.reactionDepth--;
		}
	}
};

Dispatcher.prototype.collectionBarriers = function () {
	var result = [];

	if (this.reactionDepth > 0) {
		result.push("reaction-in-progress");
	}

	if (
		this.orders.length > 0 ||
		this.pendingOrders.size > 0
	) {
		result.push("ephemeral-messages-pending");
	}

	if (this.deferred.size > 0) {
		result.push("ephemeral-ticks-pending");
	}

	if (this.agentCalls && this.agentCalls.running.size > 0) {
		result.push("external-transport-in-progress");
	}

	return result;
};

Dispatcher.prototype.collectGarbage = function () {
	var result = jobCollection.collect(this.runtime, {
		guard: this.collectionBarriers.bind(this)
	});

	this.collection = JSON.parse(JSON.stringify(result));

	return result;
};

Dispatcher.prototype.scheduleOrders = function () {
	if (!this.started || this.orderTimer !== null) {
		return;
	}

	this.orderTimer = setTimeout(function () {
		this.orderTimer = null;

		if (this.started) {
			this.scan();
		}
	}.bind(this), 0);
};

Dispatcher.prototype.sendOrder = function (
	source,
	targetKey,
	target,
	registry
) {
	if (source.persistent) {
		throw new Error("Persistent orders require a work plan");
	}

	var jobs = this.runtime.inspect().jobs;
	var sender = jobs.find(function (job) {
		return job.title === source.title;
	});
	var recipient = jobs.find(function (job) {
		return job.title === target;
	});

	if (
		!sender ||
		!sender.valid ||
		!sender.local ||
		!sender.owned ||
		sender.executor !== source.executor ||
		sender.registry[targetKey] !== target
	) {
		throw new Error("Sender no longer has authority to issue this order");
	}

	if (
		!recipient ||
		!recipient.valid ||
		!recipient.local ||
		!recipient.owned ||
		recipient.persistent
	) {
		throw new Error("Recipient must be an active local ephemeral job");
	}

	var executor = this.executors.get(recipient.executor);

	if (!executor || typeof executor[this.runtime.platform] !== "function") {
		throw new Error("Recipient executor is unavailable");
	}

	var report = hierarchy.audit(jobs);

	if (!report.valid || !report.complete) {
		throw new Error("Cannot issue an order in an invalid hierarchy");
	}

	var delivery = documentFlow.prepare(
		registry,
		{
			type: "order",
			establishing: false
		},
		this.documentRules
	);

	if (
		Object.keys(delivery.automatic).length > 0 ||
		delivery.entries.some(function (entry) {
			return entry.transfer !== "copy";
		})
	) {
		throw new Error(
			"Ordinary orders currently support only explicitly received copies"
		);
	}

	this.orders.push({
		target: target,
		executor: recipient.executor,
		registry: JSON.parse(JSON.stringify(delivery.registry))
	});

	this.scheduleOrders();
};

Dispatcher.prototype.deliverOrders = function () {
	var batch = this.orders.splice(0);
	var deferred = [];
	var delivered = 0;

	batch.forEach(function (order) {
		var job = this.runtime.inspect().jobs.find(function (candidate) {
			return candidate.title === order.target;
		});

		// These conditions really make the recipient unavailable.
		if (
			!job ||
			!job.valid ||
			!job.local ||
			!job.owned ||
			job.persistent ||
			job.executor !== order.executor
		) {
			return;
		}

		var executor = this.executors.get(job.executor);
		var handler = executor && executor[this.runtime.platform];

		if (typeof handler !== "function") {
			return;
		}

		// A newly created recipient may not have appeared in the
		// activation snapshot of the current scan yet.
		if (this.activations.get(job.title) !== job.executor) {
			deferred.push(order);
			return;
		}

		this.invoke(job, handler, {
			type: order.type || "order",
			project: order.project,
			role: order.role,
			registry: order.registry
		});

		delivered++;
	}, this);

	// Older deferred orders precede orders emitted during delivery.
	this.orders = deferred.concat(this.orders);

	if (this.orders.length > 0) {
		this.scheduleOrders();
	}

	return delivered;
};

Dispatcher.prototype.deliverFlowMessages = function () {
	var batch = Array.from(this.flowMessages.values());
	var delivered = 0;

	this.flowMessages.clear();

	batch.forEach(function (item) {
		var pending;

		try {
			pending = this.flowWal.pending(item.walTitle);
		} catch (error) {
			// The journal may have completed or been handed to the user.
			return;
		}

		var message = pending.find(function (candidate) {
			return candidate.id === item.message.id;
		});

		if (!message) {
			return;
		}

		var job = this.runtime.inspect().jobs.find(function (candidate) {
			return candidate.title === message.recipient.title;
		});

		var key = JSON.stringify([item.walTitle, message.id]);

		if (
			!job ||
			!job.valid ||
			!job.local ||
			!job.owned ||
			!job.persistent ||
			job.executor !== message.recipient.executor
		) {
			// Keep the obligation, but do not spin a retry timer.
			this.flowMessages.set(key, item);
			return;
		}

		var executor = this.executors.get(job.executor);
		var handler = executor && executor[this.runtime.platform];

		if (typeof handler !== "function") {
			this.flowMessages.set(key, item);
			return;
		}

		if (this.materializationBlockers(job).length > 0) {
			this.flowMessages.set(key, item);
			return;
		}

		var recipientTiddler = this.runtime.wiki.getTiddler(job.title);
		var startId = recipientTiddler.fields["clerus-start"];

		if (startId) {
			if (message.message !== "order" || message.id !== startId) {
				this.flowMessages.set(key, item);
				return;
			}

			this.activations.set(job.title, job.executor);
		}

		if (this.activations.get(job.title) !== job.executor) {
			this.flowMessages.set(key, item);
			this.scheduleOrders();
			return;
		}

		this.invoke(job, handler, {
			type: message.message,
			id: message.id,
			project: message.project,
			role: message.role,
			registry: message.registry,
			appointmentStart: !!startId,
			flow: {
				title: item.walTitle,
				messageId: message.id
			}
		});

		delivered++;
	}, this);

	return delivered;
};

Dispatcher.prototype.drainOfficialMessages = function () {
	var delivered;

	do {
		delivered = this.deliverOrders();
		delivered += this.deliverFlowMessages();
	} while (delivered > 0);
};

Dispatcher.prototype.scan = function () {
	var jobs = this.runtime.inspect().jobs;
	var eligible = new Set();

	jobs.forEach(function (job) {
		job = this.runtime.inspect().jobs.find(function (candidate) {
			return candidate.title === job.title;
		});

		if (!job) {
			return;
		}

		if (!job.valid || !job.local || !job.owned) {
			return;
		}

		if (this.materializationBlockers(job).length > 0) {
			return;
		}

		var executor = this.executors.get(job.executor);
		var handler = executor && executor[this.runtime.platform];

		if (typeof handler !== "function") {
			return;
		}

		eligible.add(job.title);

		var activationTiddler = this.runtime.wiki.getTiddler(job.title);
		var resuming = job.persistent &&
			activationTiddler.fields["clerus-suspended"] === "yes";

		if (
			job.persistent &&
			activationTiddler.fields["clerus-start"] &&
			!resuming
		) {
			return;
		}

		if (this.activations.get(job.title) === job.executor) {
			return;
		}

		this.activations.set(job.title, job.executor);

		var pending = this.pendingOrders.get(job.title);
		this.pendingOrders.delete(job.title);

		this.invoke(job, handler, {
			type: pending && pending.executor === job.executor
				? "order"
				: resuming
					? "resumed"
					: "ready"
		});
	}, this);

	this.activations.forEach(function (executor, title) {
		if (!eligible.has(title)) {
			this.activations.delete(title);
		}
	}, this);

	this.observe();
	this.drainOfficialMessages();
	this.collectDeferred();
	this.deliverDeferred();
	this.drainOfficialMessages();

	if (this.agentCalls) {
		this.agentCalls.scan();
	}

	if (this.autoCollectJobs) {
		this.collectGarbage();
	}
};

Dispatcher.prototype.observe = function () {
	var jobs = this.runtime.inspect().jobs.filter(function (job) {
		return job.valid &&
			job.local &&
			job.owned &&
			this.materializationBlockers(job).length === 0 &&
			this.activations.get(job.title) === job.executor;
	}, this);

	var events = this.observer.collect(
		jobs,
		function (title) {
			return jobViews.readJob(this.runtime.wiki, title);
		}.bind(this),
		function (holder, document) {
			return this.readMission(holder, document);
		}.bind(this),
		function (title) {
			return tiddlerViews.read(this.runtime.wiki, title);
		}.bind(this)
	);

	events.forEach(function (event) {
		// A previous reaction may have dismissed or changed this recipient.
		var current = this.runtime.inspect().jobs.find(function (job) {
			return job.title === event.recipient;
		});

		if (
			!current ||
			!current.valid ||
			!current.local ||
			!current.owned ||
			this.materializationBlockers(current).length > 0 ||
			this.activations.get(current.title) !== current.executor ||
			JSON.stringify(current.registry[event.key]) !== event.document
		) {
			return;
		}

		var executor = this.executors.get(current.executor);
		var handler = executor && executor[this.runtime.platform];

		if (typeof handler !== "function") {
			return;
		}

		this.invoke(current, handler, {
			type: "document-change",
			key: event.key,
			target: event.target
		});
	}, this);
};

Dispatcher.prototype.dismiss = function (job, handler, diagnostic) {
	var registry;
	var result;

	try {
		var current = this.runtime.inspect().jobs.find(function (candidate) {
			return candidate.title === job.title;
		});

		if (!current) {
			throw new Error("Cannot dismiss a missing job");
		}

		var documents = current.registry
			? Object.keys(current.registry).map(function (key) {
				return current.registry[key];
			}).filter(missions.isMission)
			: [];

		var writer = createWriter({
			wiki: this.runtime.wiki,
			job: current,
			platform: this.runtime.platform,
			Tiddler: this.Tiddler
		});

		result = detachment.resign({
			runtime: this.runtime,
			Tiddler: this.Tiddler,
			job: current,
			documents: documents,
			replace: writer
		});

		registry = lifecycle.dismissEphemeral({
			wiki: this.runtime.wiki,
			job: current,
			platform: this.runtime.platform,
			Tiddler: this.Tiddler,
			error: {
				name: diagnostic.name,
				message: diagnostic.message,
				stack: diagnostic.stack
			}
		});
	} catch (error) {
		diagnostic.transitionError = lifecycle.describeError(error);
		return;
	}

	this.activations.delete(job.title);

	var ownDetachment = result.affected.find(function (item) {
		return item.title === job.title;
	});

	this.invoke({
		title: job.title,
		executor: job.executor,
		persistent: false,
		registry: registry
	}, handler, {
		type: "dismissed",
		keys: ownDetachment ? ownDetachment.keys : [],
		roles: ownDetachment ? ownDetachment.roles : [],
		readOnly: true,
		ignoreErrors: true
	});
};

Dispatcher.prototype.start = function () {
	if (this.started) {
		return;
	}

	this.recovery = this.wal.recover();
	this.flowRecovery = this.flowWal.recover();

	this.flowRecovery.forEach(function (entry) {
		if (entry.status === "pending") {
			this.queueFlowMessages(entry.title, entry.messages);
		}
	}, this);

	this.collectDeferred();
	this.started = true;

	if (this.agentCalls) {
		this.agentCalls.start();
	}

	this.runtime.wiki.addEventListener("change", this.onChange);
	this.scan();
};

Dispatcher.prototype.stop = function () {
	if (!this.started) {
		return;
	}

	if (this.agentCalls) {
		this.agentCalls.stop();
	}

	this.runtime.wiki.removeEventListener("change", this.onChange);
	this.activations.clear();
	this.errors.clear();
	this.observer.clear();

	this.deferred.forEach(function (timer) {
		clearTimeout(timer);
	});

	this.deferred.clear();

	this.deferredTimers.forEach(function (timer) {
		clearTimeout(timer);
	});

	this.deferredTimers.clear();
	this.deferredEvents.clear();
	this.flowMessages.clear();
	this.pendingOrders.clear();

	if (this.orderTimer !== null) {
		clearTimeout(this.orderTimer);
		this.orderTimer = null;
	}

	this.orders.length = 0;
	this.started = false;
};

Dispatcher.prototype.inspect = function () {
	return {
		started: this.started,
		activations: Array.from(this.activations.keys()).sort(),
		recovery: JSON.parse(JSON.stringify(this.recovery)),
		collection: this.collection
			? JSON.parse(JSON.stringify(this.collection))
			: null,
		flowRecovery: JSON.parse(JSON.stringify(this.flowRecovery)),
		pendingFlowMessages: this.flowMessages.size,
		agentErrors: this.agentCalls
			? JSON.parse(JSON.stringify(this.agentCalls.errors))
			: [],
		errors: JSON.parse(JSON.stringify(Array.from(this.errors.values())))
	};
};

exports.Dispatcher = Dispatcher;