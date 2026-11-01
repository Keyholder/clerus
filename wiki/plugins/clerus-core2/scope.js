/*\
title: $:/plugins/clerus/core2/scope.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core2/schemas.js");
var documents = require("$:/plugins/clerus/core2/documents.js");
var operations = require("$:/plugins/clerus/core2/operation.js");

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

	var operational = schemas.registry(
		options.operational,
		"operational"
	);

	var incoming = options.incoming === undefined
		? null
		: schemas.registry(options.incoming, "incoming");

	[
		"readTiddler",
		"canWriteOperational",
		"commitOperational"
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
		nextOutgoing: 0
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
					node.form === "tiddler-title" &&
					node.value === title
				) {
					found = node;
				}
			});
		});

		return found;
	}

	function nodeFor(candidate, value) {
		if (typeof value === "string") {
			var existing = findTitle(candidate, value);

			if (existing) {
				return existing;
			}
		}

		return newNode(value);
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

	addInitial("operational", "operational", operational);

	if (incoming !== null) {
		addInitial("incoming", "incoming", incoming);
	}

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

	function serialize(registry) {
		var result = Object.create(null);

		registry.entries.forEach(function (node, key) {
			define(
				result,
				key,
				schemas.copyJSON(node.value)
			);
		});

		return result;
	}

	function fork() {
		var candidate = {
			registries: new Map(),
			nextOutgoing: state.nextOutgoing
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
				serialize(registry),
				registry.kind
			);
		});
	}

	function materialize(candidate) {
		var before = serialize(
			state.registries.get("operational")
		);

		var after = serialize(
			candidate.registries.get("operational")
		);

		if (JSON.stringify(before) === JSON.stringify(after)) {
			return;
		}

		/*
		Authorization failures belong to preparation, not here.
		This function only performs the accepted material write.
		*/
		options.commitOperational(
			schemas.copyJSON(before),
			schemas.copyJSON(after)
		);
	}

	function run(prepare) {
		return operations.run({
			assertActive: assertActive,
			fork: fork,

			validate: function (candidate) {
				validate(candidate);

				var before = serialize(
					state.registries.get("operational")
				);

				var after = serialize(
					candidate.registries.get("operational")
				);

				if (
					JSON.stringify(before) !==
					JSON.stringify(after)
				) {
					if (
						typeof options.canWriteOperational !== "function" ||
						options.canWriteOperational() !== true
					) {
						throw new Error(
							"Operational registry is not writable"
						);
					}

					if (
						typeof options.commitOperational !== "function"
					) {
						throw new Error(
							"Operational registry writer is unavailable"
						);
					}
				}
			},

			materialize: materialize,

			publish: function (candidate) {
				state = candidate;
			},

			invalidate: close
		}, prepare);
	}

	function getRegistry(candidate, id) {
		var registry = candidate.registries.get(id);

		if (!registry) {
			throw new Error("Registry is no longer available");
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

			var outgoing = [];

			state.registries.forEach(function (registry) {
				if (registry.kind === "outgoing") {
					outgoing.push(serialize(registry));
				}
			});

			return {
				operational: serialize(
					state.registries.get("operational")
				),

				incoming: incoming === null
					? null
					: serialize(state.registries.get("incoming")),

				outgoing: outgoing
			};
		},

		assertResolved: function () {
			assertActive();

			if (
				incoming !== null &&
				state.registries.get("incoming").entries.size !== 0
			) {
				throw new Error(
					"Incoming registry contains unresolved documents"
				);
			}
		},

		close: close
	});
}

exports.open = open;