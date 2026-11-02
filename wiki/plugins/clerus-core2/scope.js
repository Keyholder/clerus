/*\
title: $:/plugins/clerus/core2/scope.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var documents = require("$:/plugins/clerus/core2/documents.js");
var operations = require("$:/plugins/clerus/core2/operation.js");
var missionSchema = require(
	"$:/plugins/clerus/core2/mission-schema.js"
);
var missionIssuance = require(
	"$:/plugins/clerus/core2/mission-issuance.js"
);
var jobTitles = require(
	"$:/plugins/clerus/core2/job-titles.js"
);

function define(record, key, value) {
	Object.defineProperty(record, key, {
		value: value,
		enumerable: true,
		writable: true,
		configurable: true
	});
}

function validateTiddlerView(value, title) {
	var view = schemas.copyJSON(value);

	if (
		!schemas.isRecord(view) ||
		(
			view.kind !== "absent" &&
			view.kind !== "materialized" &&
			view.kind !== "shadow"
		)
	) {
		throw new Error("Invalid tiddler view");
	}

	if (view.kind === "absent") {
		if (view.fields !== null) {
			throw new Error("Absent tiddler must have null fields");
		}

		return view;
	}

	if (
		!schemas.isRecord(view.fields) ||
		view.fields.title !== title ||
		!Object.keys(view.fields).every(function (key) {
			return typeof view.fields[key] === "string";
		})
	) {
		throw new Error("Invalid tiddler fields");
	}

	return view;
}

function open(options) {
	options = options || {};

	var unborn = options.operational === null;

	var operational = unborn
		? null
		: schemas.registry(
			options.operational,
			"operational"
		);

	var incoming = options.incoming === undefined
		? null
		: schemas.registry(options.incoming, "incoming");

	[
		"readJob",
		"readTiddler",
		"readMission",
		"canWriteOperational",
		"commitOperational",
		"authorizeMission",
		"authorizeMissionMove",
		"authorizeOrganization",
		"issueJobTitle",
		"prepareOrder",
		"prepareReport",
		"acceptMessage",
		"checkMessage",
		"establishOperational",
		"atomicMaterialization",
		"checkDeferred",
		"acceptDeferred"
	].forEach(function (name) {
		if (
			options[name] !== undefined &&
			typeof options[name] !== "function"
		) {
			throw new Error(name + " must be a function");
		}
	});

	var active = true;

	var state = {
		registries: new Map(),
		nextOutgoing: 0,
		updates: new Map(),
		messages: [],
		deferred: false
	};

	var views = new Map();
	var viewIds = new WeakMap();

	function assertActive() {
		if (!active) {
			throw new Error("Clerus scope is closed");
		}
	}

	function close() {
		if (!active) {
			return;
		}

		active = false;
		state.registries.clear();
		views.clear();
	}

	function newNode(value) {
		return {
			form: schemas.formOf(value),
			value: value,
			instance: null
		};
	}

	function findTitle(candidate, title) {
		var found = null;

		candidate.registries.forEach(function (registry) {
			registry.entries.forEach(function (node) {
			if (
				(
					node.form === "tiddler-title" ||
					node.form === "job-title"
				) &&
				node.value === title
			) {
				found = node;
			}
			});
		});

		return found;
	}

	function findMission(candidate, value) {
		var identity = missionSchema.identity(value);
		var signature = missionSchema.delegationSignature(value);
		var found = null;

		candidate.registries.forEach(function (registry) {
			registry.entries.forEach(function (node) {
				if (
					node.form === "mission" &&
					missionSchema.identity(node.value) === identity &&
					missionSchema.delegationSignature(node.value) === signature
				) {
					found = node;
				}
			});
		});

		return found;
	}

	function nodeFor(candidate, value) {
		var form = schemas.formOf(value);
		var existing = null;

		if (form === "tiddler-title" || form === "job-title") {
			existing = findTitle(candidate, value);
		} else if (form === "mission") {
			existing = findMission(candidate, value);
		}

		return existing || newNode(value);
	}

	function addInitial(id, kind, serialized) {
		var registry = {
			kind: kind,
			entries: new Map()
		};

		state.registries.set(id, registry);

		Object.keys(serialized).forEach(function (key) {
			registry.entries.set(
				key,
				nodeFor(state, serialized[key])
			);
		});
	}

	if (!unborn) {
		addInitial("operational", "operational", operational);
	}

	if (incoming !== null) {
		addInitial("incoming", "incoming", incoming);
	}

	var establishingKey = null;

	if (unborn) {
		if (incoming === null) {
			throw new Error("Establishment requires an incoming registry");
		}

		var contracts = Object.keys(incoming).filter(function (key) {
			return schemas.formOf(incoming[key]) === "contract";
		});

		if (contracts.length !== 1) {
			throw new Error(
				"Establishment requires exactly one incoming contract"
			);
		}

		establishingKey = contracts[0];
	}

	var establishingNode = unborn
		? state.registries.get("incoming")
			.entries.get(establishingKey)
		: null;

	function isPresent(node) {
		var present = false;

		state.registries.forEach(function (registry) {
			registry.entries.forEach(function (candidate) {
				if (candidate === node) {
					present = true;
				}
			});
		});

		return present;
	}

	function assertPresent(node) {
		assertActive();

		if (!isPresent(node)) {
			throw new Error("Document is no longer available");
		}
	}

	function serialize(registry, candidate) {
		var result = Object.create(null);

		registry.entries.forEach(function (node, key) {
			var value = candidate && candidate.updates.has(node)
				? candidate.updates.get(node)
				: node.value;

			define(
				result,
				key,
				schemas.copyJSON(value)
			);
		});

		return result;
	}

	function fork() {
		var candidate = {
			registries: new Map(),
			nextOutgoing: state.nextOutgoing,
			updates: new Map(),
			messages: state.messages.slice(),
			deferred: state.deferred
		};

		state.registries.forEach(function (registry, id) {
			candidate.registries.set(id, {
				kind: registry.kind,
				entries: new Map(registry.entries)
			});
		});

		return candidate;
	}

	function validate(candidate) {
		candidate.registries.forEach(function (registry) {
			schemas.registry(
				serialize(registry, candidate),
				registry.kind
			);
		});
	}

	function authorizeOrganization(candidate) {
		var before = registrySnapshot();
		var after = registrySnapshot(candidate);

		var previous = new Set();

		Object.keys(before.operational || {}).forEach(function (key) {
			var document = before.operational[key];

			if (jobTitles.isJobTitle(document)) {
				previous.add(document);
			}
		});

		var added = Object.keys(after.operational || {}).some(function (key) {
			var document = after.operational[key];

			return jobTitles.isJobTitle(document) &&
				!previous.has(document);
		});

		if (!added) {
			return;
		}

		if (typeof options.authorizeOrganization !== "function") {
			throw new Error(
				"Organizational reference authorization is unavailable"
			);
		}

		options.authorizeOrganization(before, after);
	}

	function materialize(candidate) {
		function perform() {
			var before = operationalSnapshot();
			var after = operationalSnapshot(candidate);

			if (JSON.stringify(before) !== JSON.stringify(after)) {
				if (before === null) {
					options.establishOperational(
						schemas.copyJSON(after)
					);
				} else {
					options.commitOperational(
						schemas.copyJSON(before),
						schemas.copyJSON(after)
					);
				}
			}

			for (
				var index = state.messages.length;
				index < candidate.messages.length;
				index++
			) {
				options.acceptMessage(
					schemas.copyJSON(candidate.messages[index])
				);
			}

			if (candidate.deferred && !state.deferred) {
				options.acceptDeferred();
			}
		}

		if (typeof options.atomicMaterialization === "function") {
			return options.atomicMaterialization(perform);
		}

		return perform();
	}

	function run(prepare) {
		return operations.run({
			assertActive: assertActive,
			fork: fork,

			validate: function (candidate) {
				validate(candidate);
				authorizeOrganization(candidate);

				var before = operationalSnapshot();
				var after = operationalSnapshot(candidate);

				if (JSON.stringify(before) !== JSON.stringify(after)) {
					if (before === null) {
						if (typeof options.establishOperational !== "function") {
							throw new Error("Establishment materializer is unavailable");
						}
					} else {
						if (
							typeof options.canWriteOperational !== "function" ||
							options.canWriteOperational() !== true
						) {
							throw new Error("Operational registry is not writable");
						}

						if (typeof options.commitOperational !== "function") {
							throw new Error(
								"Operational registry writer is unavailable"
							);
						}
					}
				}
			},

			materialize: materialize,

			publish: function (candidate) {
				candidate.updates.forEach(function (value, node) {
					node.value = value;
				});

				candidate.updates.clear();
				state = candidate;
			},

			invalidate: close,

			atomicMaterialization:
				typeof options.atomicMaterialization === "function"
		}, prepare);
	}

	function getRegistry(candidate, id) {
		var registry = candidate.registries.get(id);

		if (!registry) {
			throw new Error(
				id === "operational"
					? "Job is not established"
					: "Registry is no longer available"
			);
		}

		return registry;
	}

	function getNode(candidate, id, key) {
		schemas.assertKey(key);

		var node = getRegistry(candidate, id).entries.get(key);

		if (!node) {
			throw new Error("Unknown document key: " + key);
		}

		return node;
	}

	function resolveDestination(destination) {
		if (
			destination === null ||
			typeof destination !== "object" ||
			!viewIds.has(destination)
		) {
			throw new Error(
				"Destination must belong to this scope"
			);
		}

		return viewIds.get(destination);
	}

	function updateNode(node, field, value) {
		run(function (candidate) {
			assertPresent(node);

			if (
				(node.form !== "memo" || field !== "data") &&
				(node.form !== "charter" || field !== "status")
			) {
				throw new Error("Unsupported document update");
			}

			var next = schemas.copyJSON(node.value);

			define(next, field, schemas.copyJSON(value));

			// Validate before placing the proposal in the candidate.
			next = schemas.document(next);

			candidate.updates.set(node, next);
		});
	}

	function createMemo(node, data, destination, key) {
		assertPresent(node);

		if (node.form !== "charter") {
			throw new Error("Only charter can create memos");
		}

		var destinationId = resolveDestination(destination);

		run(function (candidate) {
			assertPresent(node);
			schemas.assertKey(key);

			var target = getRegistry(candidate, destinationId);

			if (target.kind === "incoming") {
				throw new Error(
					"Cannot insert documents into incoming registry"
				);
			}

			if (target.entries.has(key)) {
				throw new Error("Document key already exists: " + key);
			}

			var document = schemas.document({
				form: "memo",
				data: data
			});

			target.entries.set(key, newNode(document));
		});

		return registryView(destinationId).get(key);
	}

	function operationalSnapshot(candidate) {
		var source = candidate || state;
		var registry = source.registries.get("operational");

		return registry
			? serialize(registry, source)
			: null;
	}

	function registrySnapshot(candidate) {
		var source = candidate || state;
		var outgoing = [];

		source.registries.forEach(function (registry) {
			if (registry.kind === "outgoing") {
				outgoing.push(serialize(registry, source));
			}
		});

		return {
			operational: operationalSnapshot(source),

			incoming: incoming === null
				? null
				: serialize(
					source.registries.get("incoming"),
					source
				),

			outgoing: outgoing,
			messages: schemas.copyJSON(source.messages),
		};
	}

	function prepareMissionAliases(candidate, node) {
		var identity = missionSchema.identity(node.value);
		var registry = Object.create(null);
		var nodesByKey = new Map();
		var parentKey = null;
		var sequence = 0;

		candidate.registries.forEach(function (source) {
			source.entries.forEach(function (entry) {
				if (
					entry.form !== "mission" ||
					missionSchema.identity(entry.value) !== identity
				) {
					return;
				}

				sequence++;

				var key = "parent-" + sequence;
				var value = candidate.updates.has(entry)
					? candidate.updates.get(entry)
					: entry.value;

				define(registry, key, schemas.copyJSON(value));
				nodesByKey.set(key, entry);

				if (entry === node && parentKey === null) {
					parentKey = key;
				}
			});
		});

		if (parentKey === null) {
			throw new Error("Mission is no longer available");
		}

		return {
			registry: registry,
			nodesByKey: nodesByKey,
			parentKey: parentKey
		};
	}

	function publishMissionAliases(candidate, prepared, result) {
		result.parentKeys.forEach(function (key) {
			candidate.updates.set(
				prepared.nodesByKey.get(key),
				missionSchema.validate(result.registry[key])
			);
		});
	}

	function authorizeMission(node, operation, segment) {
		assertPresent(node);

		if (node.form !== "mission") {
			throw new Error("Document is not a mission");
		}

		if (typeof options.authorizeMission !== "function") {
			throw new Error("Mission mutation authorization is unavailable");
		}

		options.authorizeMission(
			missionSchema.validate(node.value),
			registrySnapshot(),
			operation,
			segment
		);
	}

	function issueMission(node, segment, destination, key) {
		assertPresent(node);

		var destinationId = resolveDestination(destination);

		run(function (candidate) {
			schemas.assertKey(key);

			var target = getRegistry(candidate, destinationId);

			if (target.kind === "incoming") {
				throw new Error(
					"Cannot insert documents into incoming registry"
				);
			}

			if (target.entries.has(key)) {
				throw new Error("Document key already exists: " + key);
			}

			authorizeMission(node, "issue", segment);

			var prepared = prepareMissionAliases(candidate, node);

			/*
			Alias keys use the parent- prefix, so this key cannot collide.
			*/
			var result = missionIssuance.issue(
				prepared.registry,
				prepared.parentKey,
				segment,
				"issued-child"
			);

			publishMissionAliases(candidate, prepared, result);

			target.entries.set(
				key,
				newNode(missionSchema.validate(result.document))
			);
		});

		return registryView(destinationId).get(key);
	}

	function revokeMission(node, segment) {
		run(function (candidate) {
			authorizeMission(node, "revoke", segment);

			var prepared = prepareMissionAliases(candidate, node);

			var result = missionIssuance.revoke(
				prepared.registry,
				prepared.parentKey,
				segment
			);

			publishMissionAliases(candidate, prepared, result);
		});
	}

	function sendOrder(node, outgoing) {
		assertPresent(node);

		if (node.form !== "job-title") {
			throw new Error("Order recipient is not a job title");
		}

		var outgoingId = resolveDestination(outgoing);

		run(function (candidate) {
			assertPresent(node);

			var registry = getRegistry(candidate, outgoingId);

			if (registry.kind !== "outgoing") {
				throw new Error("Order requires an outgoing registry");
			}

			if (typeof options.prepareOrder !== "function") {
				throw new Error("Order authorization is unavailable");
			}

			if (typeof options.acceptMessage !== "function") {
				throw new Error("Message acceptance is unavailable");
			}

			var message = schemas.copyJSON(
				options.prepareOrder(
					node.value,
					serialize(registry, candidate),
					registrySnapshot()
				)
			);

			if (
				!schemas.isRecord(message) ||
				message.type !== "order" ||
				message.recipient !== node.value
			) {
				throw new Error("Invalid prepared order");
			}

			if (typeof options.checkMessage === "function") {
				options.checkMessage(schemas.copyJSON(message));
			}

			/*
			The registry becomes message-owned. It is no longer an
			accessible outgoing registry of this reaction.
			*/
			candidate.registries.delete(outgoingId);
			candidate.messages.push(message);
		});
	}

	function sendReport(node, outgoing) {
		assertPresent(node);

		if (node.form !== "mission") {
			throw new Error("Report requires a mission");
		}

		if (options.eventType === "order") {
			throw new Error("Cannot report while reacting to an order");
		}

		var outgoingId = resolveDestination(outgoing);

		run(function (candidate) {
			assertPresent(node);

			var registry = getRegistry(candidate, outgoingId);

			if (registry.kind !== "outgoing") {
				throw new Error("Report requires an outgoing registry");
			}

			if (typeof options.prepareReport !== "function") {
				throw new Error("Report authorization is unavailable");
			}

			if (typeof options.acceptMessage !== "function") {
				throw new Error("Message acceptance is unavailable");
			}

			var message = schemas.copyJSON(
				options.prepareReport(
					missionSchema.validate(node.value),
					serialize(registry, candidate),
					registrySnapshot()
				)
			);

			if (
				!schemas.isRecord(message) ||
				message.type !== "report" ||
				typeof message.recipient !== "string" ||
				message.project !== node.value.project ||
				JSON.stringify(message.role) !==
					JSON.stringify(node.value.role)
			) {
				throw new Error("Invalid prepared report");
			}

			if (typeof options.checkMessage === "function") {
				options.checkMessage(schemas.copyJSON(message));
			}

			candidate.registries.delete(outgoingId);
			candidate.messages.push(message);
		});
	}

	function createJobTitle(node, segment, destination, key, temporary) {
		assertPresent(node);

		if (node.form !== "charter") {
			throw new Error("Only charter can issue job titles");
		}

		var destinationId = resolveDestination(destination);

		run(function (candidate) {
			assertPresent(node);
			schemas.assertKey(key);

			var target = getRegistry(candidate, destinationId);

			if (target.kind === "incoming") {
				throw new Error(
					"Cannot insert documents into incoming registry"
				);
			}

			if (target.entries.has(key)) {
				throw new Error("Document key already exists: " + key);
			}

			if (typeof options.issueJobTitle !== "function") {
				throw new Error("Job title issuance is unavailable");
			}

			/*
			Initial organizational ownership is explicit:
			the new subordinate title must first enter the
			issuing job's operational registry.
			*/
			if (target.kind !== "operational") {
				throw new Error(
					"New job title must be issued operationally"
				);
			}

			var title = options.issueJobTitle(segment, temporary);

			if (!jobTitles.isJobTitle(title)) {
				throw new Error("Issuer returned an invalid job title");
			}

			target.entries.set(key, nodeFor(candidate, title));
		});

		return registryView(destinationId).get(key);
	}

	function acceptContract(node, key, status) {
		run(function (candidate) {
			assertPresent(node);
			schemas.assertKey(key);

			if (
				!unborn ||
				node !== establishingNode ||
				candidate.registries.has("operational")
			) {
				throw new Error(
					"Contract cannot establish this scope"
				);
			}

			var charter = {
				form: "charter",
				status: schemas.copyJSON(status)
			};

			if (
				Object.prototype.hasOwnProperty.call(
					node.value,
					"book"
				)
			) {
				define(
					charter,
					"book",
					schemas.copyJSON(node.value.book)
				);
			}

			charter = schemas.document(charter);

			/*
			Consume the actual received contract node.
			Equal but independently supplied contracts are not aliases.
			*/
			candidate.registries.forEach(function (registry) {
				var removed = [];

				registry.entries.forEach(function (entry, entryKey) {
					if (entry === node) {
						removed.push(entryKey);
					}
				});

				removed.forEach(function (entryKey) {
					registry.entries.delete(entryKey);
				});
			});

			candidate.registries.set("operational", {
				kind: "operational",
				entries: new Map([
					[key, newNode(charter)]
				])
			});
		});

		return registryView("operational").get(key);
	}

	function defer(node) {
		run(function (candidate) {
			assertPresent(node);

			if (node.form !== "charter") {
				throw new Error("Deferred activation requires a charter");
			}

			if (candidate.deferred) {
				return;
			}

			if (
				typeof options.checkDeferred !== "function" ||
				typeof options.acceptDeferred !== "function"
			) {
				throw new Error("Deferred activation is unavailable");
			}

			options.checkDeferred();
			candidate.deferred = true;
		});
	}

	function instanceFor(node) {
		assertPresent(node);

		if (node.instance) {
			return node.instance;
		}

		node.instance = documents.create(
			node.form,
			Object.freeze({
				read: function () {
					assertPresent(node);
					return schemas.copyJSON(node.value);
				},

				setData: function (value) {
					updateNode(node, "data", value);
				},

				setStatus: function (value) {
					updateNode(node, "status", value);
				},

				createMemo: function (data, destination, key) {
					return createMemo(node, data, destination, key);
				},

				inspectJob: function () {
					assertPresent(node);

					if (node.form !== "job-title") {
						throw new Error("Document is not a job title");
					}

					if (typeof options.readJob !== "function") {
						throw new Error("Job inspection is unavailable");
					}

					var result = schemas.copyJSON(
						options.readJob(node.value)
					);

					if (
						!schemas.isRecord(result) ||
						typeof result.exists !== "boolean" ||
						typeof result.readable !== "boolean" ||
						!Object.prototype.hasOwnProperty.call(result, "status") ||
						(
							result.reason !== null &&
							typeof result.reason !== "string"
						) ||
						(result.readable && !result.exists)
					) {
						throw new Error("Invalid job inspection result");
					}

					return result;
				},

				inspectTiddler: function () {
					assertPresent(node);

					if (node.form !== "tiddler-title") {
						throw new Error(
							"Document is not a tiddler title"
						);
					}

					if (
						typeof options.readTiddler !== "function"
					) {
						throw new Error(
							"Tiddler reading is unavailable"
						);
					}

					return validateTiddlerView(
						options.readTiddler(node.value),
						node.value
					);
				},

				inspectMission: function () {
					assertPresent(node);

					if (node.form !== "mission") {
						throw new Error("Document is not a mission");
					}

					if (typeof options.readMission !== "function") {
						throw new Error("Mission inspection is unavailable");
					}

					var result = schemas.copyJSON(
						options.readMission(
							missionSchema.validate(node.value),
							registrySnapshot()
						)
					);

					if (
						!schemas.isRecord(result) ||
						typeof result.active !== "boolean" ||
						typeof result.readable !== "boolean" ||
						!Object.prototype.hasOwnProperty.call(result, "task") ||
						(
							result.reason !== null &&
							typeof result.reason !== "string"
						) ||
						(result.readable && !result.active)
					) {
						throw new Error("Invalid mission inspection result");
					}

					return result;
				},

				issueMission: function (segment, destination, key) {
					return issueMission(node, segment, destination, key);
				},

				revokeMission: function (segment) {
					revokeMission(node, segment);
				},

				sendOrder: function (outgoing) {
					sendOrder(node, outgoing);
				},

				sendReport: function (outgoing) {
					sendReport(node, outgoing);
				},

				createJobTitle: function (segment, destination, key, temporary) {
					return createJobTitle(
						node,
						segment,
						destination,
						key,
						temporary
					);
				},

				acceptContract: function (key, status) {
					return acceptContract(node, key, status);
				},

				defer: function () {
					defer(node);
				}
			})
		);

		return node.instance;
	}

	function transfer(sourceId, sourceKey, destination, key, move) {
		assertActive();

		var destinationId = resolveDestination(destination);

		run(function (candidate) {
			schemas.assertKey(key);

			var node = getNode(
				candidate,
				sourceId,
				sourceKey
			);

			if (node.form === "charter") {
				throw new Error(
					"Charter cannot be copied or moved"
				);
			}

			if (node.form === "contract" && !move) {
				throw new Error("Contract cannot be copied");
			}

			if (node.form === "mission" && !move) {
				throw new Error("Mission cannot be copied");
			}

			var target = getRegistry(candidate, destinationId);

			if (target.kind === "incoming") {
				throw new Error(
					"Cannot insert documents into incoming registry"
				);
			}

			if (target.entries.has(key)) {
				throw new Error(
					"Document key already exists: " + key
				);
			}

			if (node.form === "mission") {
				if (typeof options.authorizeMissionMove !== "function") {
					throw new Error("Mission movement authorization is unavailable");
				}

				options.authorizeMissionMove(
					missionSchema.validate(node.value),
					registrySnapshot()
				);

				var identity = missionSchema.identity(node.value);

				/*
					A non-copyable assignment is moved as a whole.
					All its local representations are consumed.
				*/
				candidate.registries.forEach(function (registry) {
					var removed = [];

					registry.entries.forEach(function (entry, entryKey) {
						if (
							entry.form === "mission" &&
							missionSchema.identity(entry.value) === identity
						) {
							removed.push(entryKey);
						}
					});

					removed.forEach(function (entryKey) {
						registry.entries.delete(entryKey);
					});
				});

				target.entries.set(key, node);

				return;
			}

			/*
			Copying a memo creates a separate mutable document.
			Moving preserves its instrument node.
			Title copies share instrument access.
			*/
			var placed = move
				? node
				: nodeFor(
					candidate,
					schemas.copyJSON(node.value)
				);

			if (move) {
				getRegistry(candidate, sourceId)
					.entries.delete(sourceKey);
			}

			target.entries.set(key, placed);
		});
	}

	function registryView(id) {
		if (views.has(id)) {
			return views.get(id);
		}

		var view = Object.freeze({
			keys: function () {
				assertActive();

				return Array.from(
					getRegistry(state, id).entries.keys()
				);
			},

			get: function (key) {
				assertActive();
				return instanceFor(getNode(state, id, key));
			},

			copy: function (sourceKey, destination, destinationKey) {
				transfer(
					id,
					sourceKey,
					destination,
					destinationKey,
					false
				);
			},

			move: function (sourceKey, destination, destinationKey) {
				transfer(
					id,
					sourceKey,
					destination,
					destinationKey,
					true
				);
			},

			destroy: function (key) {
				run(function (candidate) {
					var node = getNode(candidate, id, key);

					if (node.form === "charter") {
						throw new Error(
							"Charter cannot be destroyed separately"
						);
					}

					if (node.form === "mission") {
						var identity = missionSchema.identity(node.value);

						candidate.registries.forEach(function (registry) {
							var removed = [];

							registry.entries.forEach(function (entry, entryKey) {
								if (
									entry.form === "mission" &&
									missionSchema.identity(entry.value) === identity
								) {
									removed.push(entryKey);
								}
							});

							removed.forEach(function (entryKey) {
								registry.entries.delete(entryKey);
							});
						});

						return;
					}

					getRegistry(candidate, id).entries.delete(key);
				});
			},

			outgoing: function () {
				var outgoingId = run(function (candidate) {
					candidate.nextOutgoing++;

					var nextId =
						"outgoing-" + candidate.nextOutgoing;

					candidate.registries.set(nextId, {
						kind: "outgoing",
						entries: new Map()
					});

					return nextId;
				});

				return registryView(outgoingId);
			}
		});

		views.set(id, view);
		viewIds.set(view, id);

		return view;
	}

	return Object.freeze({
		operational: registryView("operational"),

		incoming: incoming === null
			? null
			: registryView("incoming"),

		/*
		Controller API. The executor receives registry views only.
		*/
		snapshot: function () {
			assertActive();
			return registrySnapshot();
		},

		assertResolved: function () {
			assertActive();

			if (unborn && !state.registries.has("operational")) {
				throw new Error("Establishment contract was not accepted");
			}

			if (
				incoming !== null &&
				state.registries.get("incoming").entries.size !== 0
			) {
				throw new Error(
					"Incoming registry contains unresolved documents"
				);
			}
		},

		assertOutgoingResolved: function () {
			assertActive();

			var unresolved = false;

			state.registries.forEach(function (registry) {
				if (
					registry.kind === "outgoing" &&
					registry.entries.size !== 0
				) {
					unresolved = true;
				}
			});

			if (unresolved) {
				throw new Error(
					"Outgoing registries contain unsent documents"
				);
			}
		},

		close: close
	});
}

exports.open = open;