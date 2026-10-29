/*\
title: $:/plugins/clerus/core/wal.js
type: application/javascript
module-type: library
\*/

"use strict";

var effects = require("$:/plugins/clerus/core/effects.js");
var workPlans = require("$:/plugins/clerus/core/work-plan.js");
var tiddlerViews =
	require("$:/plugins/clerus/core/tiddler-view.js");

function describeError(error) {
	return {
		name: error && error.name ? String(error.name) : "Error",
		message: String(error && error.message || error),
		stack: error && error.stack ? String(error.stack) : null
	};
}

function defaultId() {
	return Date.now().toString(36) + "-" +
		Math.random().toString(36).slice(2) + "-" +
		Math.random().toString(36).slice(2);
}

function Wal(options) {
	this.wiki = options.wiki;
	this.Tiddler = options.Tiddler;
	this.platform = options.platform;
	this.idFactory = options.idFactory || defaultId;
	this.prefix = "$:/clerus/wal/" + this.platform + "/";
}

function sameFields(left, right) {
	function canonical(fields) {
		if (!fields) {
			return null;
		}

		return Object.keys(fields).sort().map(function (key) {
			return [key, fields[key]];
		});
	}

	return JSON.stringify(canonical(left)) ===
		JSON.stringify(canonical(right));
}

Wal.prototype.validate = function (record) {
	if (
		!record ||
		record.version !== 1 ||
		record.platform !== this.platform ||
		!record.owner ||
		typeof record.owner.title !== "string" ||
		record.owner.title.indexOf("$:/clerus/jobs/") !== 0 ||
		typeof record.owner.executor !== "string" ||
		!record.owner.executor ||
		!record.owner.state ||
		!record.plan ||
		record.plan.version !== 1 ||
		!Array.isArray(record.plan.effects) ||
		record.plan.effects.length === 0
	) {
		throw new Error("Invalid work-plan WAL");
	}

	if (
		record.plan &&
		record.plan.messages !== undefined &&
		(
			!Array.isArray(record.plan.messages) ||
			record.plan.messages.length > 0
		)
	) {
		throw new Error("Message-bearing WAL is not supported yet");
	}

	var baseline = record.owner.state;

	if (
		baseline.title !== record.owner.title ||
		baseline.type !== "application/json" ||
		baseline["clerus-custody"] !== this.platform ||
		baseline["clerus-executor"] !== record.owner.executor
	) {
		throw new Error("Invalid WAL owner baseline");
	}

	if (
		record.plan.deferred !== undefined &&
		(
			!Array.isArray(record.plan.deferred) ||
			record.plan.deferred.length > 0
		)
	) {
		throw new Error("Deferred WAL requires a transactional flow");
	}

	if (
		record.plan.appointments !== undefined &&
		(
			!Array.isArray(record.plan.appointments) ||
			record.plan.appointments.length > 0
		)
	) {
		throw new Error("Appointment plans require a transactional dispatcher");
	}

	var seen = new Set();

	record.plan.effects.forEach(function (effect) {
		if (
			!effect ||
			effect.version !== 1 ||
			typeof effect.title !== "string" ||
			seen.has(effect.title) ||
			(
				effect.before !== null &&
				(
					!effect.before ||
					effect.before.title !== effect.title ||
					effect.before["clerus-custody"] !== this.platform
				)
			)
		) {
			throw new Error("Invalid or repeated WAL target");
		}

		seen.add(effect.title);

		if (
			effect.kind !== "tiddler-put" &&
			effect.kind !== "tiddler-delete"
		) {
			throw new Error("Unsupported WAL effect");
		}

		if (effect.kind === "tiddler-put") {
			if (
				!effect.after ||
				effect.after.title !== effect.title ||
				effect.after["clerus-custody"] !== this.platform
			) {
				throw new Error("WAL cannot change target custody or identity");
			}
		} else if (!effect.before || effect.after !== null) {
			throw new Error("Deletion requires an existing initial state");
		}

		if (effect.title === record.owner.title) {
			if (
				effect.kind !== "tiddler-put" ||
				!effect.before ||
				!sameFields(effect.before, baseline) ||
				effect.after.type !== "application/json" ||
				effect.after["clerus-executor"] !== record.owner.executor
			) {
				throw new Error("WAL cannot delete or replace its owner");
			}
		} else if (!tiddlerViews.isOrdinaryTitle(effect.title)) {
			throw new Error("External WAL targets must be ordinary tiddlers");
		}
	}, this);
};

Wal.prototype.checkOwner = function (record) {
	var owner = this.wiki.getTiddler(record.owner.title);

	if (
		!owner ||
		owner.fields["clerus-custody"] !== this.platform ||
		owner.fields["clerus-executor"] !== record.owner.executor
	) {
		throw new Error("WAL owner is no longer locally authorized");
	}

	var current = effects.capture(owner);
	var ownerEffect = record.plan.effects.find(function (effect) {
		return effect.title === record.owner.title;
	});

	if (
		!sameFields(current, record.owner.state) &&
		!(ownerEffect && sameFields(current, ownerEffect.after))
	) {
		throw new Error("WAL owner state has changed");
	}
};

Wal.prototype.checkCreationTargets = function (record) {
	record.plan.effects.forEach(function (effect) {
		if (
			effect.before === null &&
			this.wiki.isShadowTiddler(effect.title)
		) {
			throw new Error("Creation WAL target became shadow-backed");
		}
	}, this);
};

Wal.prototype.allocate = function () {
	for (var attempt = 0; attempt < 16; attempt++) {
		var id = this.idFactory();

		if (typeof id !== "string" || !/^[A-Za-z0-9_-]+$/.test(id)) {
			throw new Error("Invalid WAL identifier");
		}

		var title = this.prefix + id;

		if (!this.wiki.getTiddler(title)) {
			return title;
		}
	}

	throw new Error("Could not allocate a WAL title");
};

Wal.prototype.record = function (job, plan, options) {
	options = options || {};
	var record = JSON.parse(JSON.stringify({
		version: 1,
		platform: this.platform,
		owner: {
			title: job.title,
			executor: job.executor,
			state: options.ownerState ||
				effects.capture(this.wiki.getTiddler(job.title))
		},
		plan: plan
	}));

	if (!job.persistent) {
		throw new Error("Registry WAL requires a persistent owner");
	}

	this.validate(record);
	this.checkOwner(record);
	this.checkCreationTargets(record);

	record.plan.effects.forEach(function (effect) {
		effects.check(this.wiki, effect);
	}, this);

	var title = this.allocate();

	effects.apply(
		this.wiki,
		this.Tiddler,
		effects.put(null, new this.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": this.platform,
			text: JSON.stringify(record)
		}))
	);

	return title;
};

Wal.prototype.recordIncident = function (job, event, error) {
	if (
		!job.persistent ||
		job.title.indexOf("$:/clerus/jobs/") !== 0
	) {
		throw new Error("Incident WAL requires a persistent owner");
	}

	var title = this.allocate();
	var record = {
		version: 1,
		platform: this.platform,
		owner: {
			title: job.title,
			executor: job.executor
		},
		incident: {
			event: event,
			error: error
		}
	};

	effects.apply(
		this.wiki,
		this.Tiddler,
		effects.put(null, new this.Tiddler({
			title: title,
			type: "application/json",
			"clerus-custody": "user",
			text: JSON.stringify(record)
		}))
	);

	return title;
};

Wal.prototype.pause = function (title, error) {
	var current = this.wiki.getTiddler(title);

	if (!current || current.fields["clerus-custody"] !== this.platform) {
		return;
	}

	// Preserve the original body, even if it is malformed.
	effects.apply(
		this.wiki,
		this.Tiddler,
		effects.put(current, new this.Tiddler(current, {
			"clerus-custody": "user",
			"clerus-wal-error": JSON.stringify(describeError(error))
		}))
	);
};

Wal.prototype.resume = function (title) {
	try {
		if (title.indexOf(this.prefix) !== 0) {
			throw new Error("Cannot resume a foreign WAL");
		}

		var journal = this.wiki.getTiddler(title);

		if (
			!journal ||
			journal.fields.type !== "application/json" ||
			journal.fields["clerus-custody"] !== this.platform
		) {
			throw new Error("WAL is not locally owned");
		}

		var record = JSON.parse(journal.fields.text);

		this.validate(record);
		this.checkOwner(record);
	    this.checkCreationTargets(record);

		var results = workPlans.materialize(
			this.wiki,
			this.Tiddler,
			record.plan
		);

		effects.apply(
			this.wiki,
			this.Tiddler,
			effects.remove(journal)
		);

		return results;
	} catch (error) {
		this.pause(title, error);
		error.walTitle = title;
		throw error;
	}
};

Wal.prototype.commit = function (job, plan, options) {
	if (
		plan.messages !== undefined &&
		(
			!Array.isArray(plan.messages) ||
			plan.messages.length > 0
		)
	) {
		throw new Error("Message-bearing WAL is not supported yet");
	}

	if (
		plan.deferred !== undefined &&
		(
			!Array.isArray(plan.deferred) ||
			plan.deferred.length > 0
		)
	) {
		throw new Error("Deferred WAL requires a transactional flow");
	}

	if (
		plan.appointments !== undefined &&
		(
			!Array.isArray(plan.appointments) ||
			plan.appointments.length > 0
		)
	) {
		throw new Error("Appointment plans require a transactional dispatcher");
	}

	if (plan.effects.length === 0) {
		return [];
	}

	var title = this.record(job, plan, options);

	return this.resume(title);
};

Wal.prototype.recover = function () {
	var titles = [];

	this.wiki.each(function (tiddler, title) {
		if (
			title.indexOf(this.prefix) === 0 &&
			tiddler.fields["clerus-wal-kind"] !== "flow" &&
			tiddler.fields["clerus-wal-kind"] !== "deferred"
		) {
			titles.push(title);
		}
	}.bind(this));

	return titles.sort().map(function (title) {
		var journal = this.wiki.getTiddler(title);

		if (journal.fields["clerus-custody"] !== this.platform) {
			return {
				title: title,
				status: "paused"
			};
		}

		try {
			return {
				title: title,
				status: "recovered",
				results: this.resume(title)
			};
		} catch (error) {
			return {
				title: title,
				status: "failed",
				error: describeError(error)
			};
		}
	}, this);
};

exports.Wal = Wal;