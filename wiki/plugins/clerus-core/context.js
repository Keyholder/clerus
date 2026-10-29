/*\
title: $:/plugins/clerus/core/context.js
type: application/javascript
module-type: library
\*/

"use strict";

var jobViews = require("$:/plugins/clerus/core/job-view.js");
var tiddlerViews =
	require("$:/plugins/clerus/core/tiddler-view.js");
var missions = require("$:/plugins/clerus/core/missions.js");

function copy(value) {
	return value === undefined
		? undefined
		: JSON.parse(JSON.stringify(value));
}

function loadForms(modules) {
	var forms = new Map();

	modules.forEachModuleOfType("clerus-document", function (title, exports) {
		Object.keys(exports.forms || {}).forEach(function (name) {
			if (forms.has(name)) {
				throw new Error("Duplicate document form: " + name);
			}

			var factory = exports.forms[name];

			if (typeof factory !== "function") {
				throw new Error("Invalid document factory: " + title);
			}

			forms.set(name, factory);
		});
	});

	return forms;
}

function openContext(registry, forms, options) {
	options = options || {};

	var active = true;
	var documents = copy(registry);
	var instances = new Map();
	var generations = new Map();

	Object.keys(documents).forEach(function (key) {
		generations.set(key, {});
	});

	function assertActive() {
		if (!active) {
			throw new Error("Clerus context is closed");
		}
	}

	function insertDocument(key, document, commit) {
		assertActive();

		if (typeof key !== "string" || key.length === 0) {
			throw new Error("Destination key must be non-empty");
		}

		if (Object.prototype.hasOwnProperty.call(documents, key)) {
			throw new Error("Document key already exists: " + key);
		}

		var next = copy(document);

		commit(next);

		Object.defineProperty(documents, key, {
			value: next,
			enumerable: true,
			writable: true,
			configurable: true
		});

		generations.set(key, {});

		return context.get(key);
	}

	function sameDocument(left, right) {
		if (typeof left === "string" || typeof right === "string") {
			return left === right;
		}

		if (!left || !right || left.form !== right.form) {
			return false;
		}

		if (left.form === "mission") {
			return missions.sameIdentity(left, right);
		}

		return true;
	}

	function replaceLocalRegistry(registry) {
		assertActive();

		var next = copy(registry);

		Object.keys(documents).forEach(function (key) {
			if (
				!Object.prototype.hasOwnProperty.call(next, key) ||
				!sameDocument(documents[key], next[key])
			) {
				generations.delete(key);
				instances.delete(key);
			}
		});

		Object.keys(next).forEach(function (key) {
			if (!generations.has(key)) {
				generations.set(key, {});
			}
		});

		documents = next;
	}

	var context = Object.freeze({
		keys: function () {
			assertActive();
			return Object.keys(documents);
		},

		get: function (key) {
			assertActive();

			if (typeof key !== "string") {
				throw new Error("Document key must be a string");
			}

			if (!Object.prototype.hasOwnProperty.call(documents, key)) {
				throw new Error("Unknown document key: " + key);
			}

			if (instances.has(key)) {
				return instances.get(key);
			}

			var document = documents[key];
			var form;

			if (typeof document === "string") {
				if (jobViews.isJobTitle(document)) {
					form = "job-title";
				} else if (tiddlerViews.isOrdinaryTitle(document)) {
					form = "tiddler-title";
				} else {
					throw new Error("Unsupported title document");
				}
			} else {
				form = document && typeof document === "object"
					? document.form
					: null;
			}

			if (
				options.allowedForms &&
				options.allowedForms.indexOf(form) === -1
			) {
				throw new Error(
					"Document form is not yet supported in planned reactions: " +
					form
				);
			}

			var factory = forms.get(form);

			if (!factory) {
				throw new Error("Unsupported document form at key: " + key);
			}

			var generation = generations.get(key);

			function assertPresent() {
				assertActive();

				if (
					!Object.prototype.hasOwnProperty.call(documents, key) ||
					generations.get(key) !== generation
				) {
					throw new Error("Document is no longer in this context");
				}
			}

			var instance = factory(Object.freeze({
				key: key,

				inspectTiddler: function () {
					assertPresent();

					var title = documents[key];

					if (!tiddlerViews.isOrdinaryTitle(title)) {
						throw new Error("Document is not an ordinary tiddler title");
					}

					if (typeof options.readTiddler !== "function") {
						throw new Error("Tiddler inspection is unavailable");
					}

					return copy(options.readTiddler(title));
				},

				filterTitles: function () {
					assertPresent();

					if (typeof options.filterTitles !== "function") {
						throw new Error("Filter evaluation is unavailable");
					}

					return copy(options.filterTitles(copy(documents[key])));
				},

				issueTitle: function (title, destinationKey) {
					assertPresent();

					if (typeof options.issueTitle !== "function") {
						throw new Error("Title issuance is unavailable");
					}

					return insertDocument(
						destinationKey,
						title,
						function (next) {
							options.issueTitle(
								key,
								copy(documents[key]),
								next,
								destinationKey
							);
						}
					);
				},

				createTiddler: function (
					templateName,
					parameters,
					destinationKey
				) {
					assertPresent();

					if (
						typeof destinationKey !== "string" ||
						destinationKey.length === 0
					) {
						throw new Error("Destination key must be non-empty");
					}

					if (
						Object.prototype.hasOwnProperty.call(
							documents, destinationKey
						)
					) {
						throw new Error("Document key already exists");
					}

					if (typeof options.createTiddler !== "function") {
						throw new Error("Tiddler creation is unavailable");
					}

					var title = options.createTiddler(
						key,
						copy(documents[key]),
						templateName,
						parameters,
						destinationKey
					);

					// The runtime already materialized the registry insertion.
					return insertDocument(destinationKey, title, function () {});
				},

				writeTiddler: function (operation, warrantKey, patch) {
					assertPresent();

					if (
						typeof warrantKey !== "string" ||
						!Object.prototype.hasOwnProperty.call(
							documents, warrantKey
						)
					) {
						throw new Error("Unknown write warrant key");
					}

					var warrant = documents[warrantKey];

					if (
						!warrant ||
						typeof warrant !== "object" ||
						Array.isArray(warrant) ||
						warrant.form !== "warrant"
					) {
						throw new Error("Document is not a write warrant");
					}

					if (typeof options.writeTiddler !== "function") {
						throw new Error("Tiddler writes are unavailable");
					}

					options.writeTiddler(
						key,
						documents[key],
						warrantKey,
						copy(warrant),
						operation,
						patch
					);
				},

				inspectJob: function () {
					assertPresent();

					var title = documents[key];

					if (!jobViews.isJobTitle(title)) {
						throw new Error("Document is not a job title");
					}

					if (typeof options.readJob !== "function") {
						throw new Error("Job inspection is unavailable");
					}

					return copy(options.readJob(title));
				},

                read: function () {
					assertPresent();
					return copy(documents[key]);
				},

				updateDocuments: function (keys, update) {
					assertPresent();

					if (
						!options.atomicRegistryUpdates ||
						typeof options.replace !== "function" ||
						typeof options.replace.replaceAll !== "function"
					) {
						throw new Error(
							"Atomic document updates require a planned operational context"
						);
					}

					if (
						!Array.isArray(keys) ||
						keys.length === 0 ||
						new Set(keys).size !== keys.length ||
						!keys.every(function (selectedKey) {
							return typeof selectedKey === "string" &&
								Object.prototype.hasOwnProperty.call(
									documents, selectedKey
								);
						}) ||
						typeof update !== "function"
					) {
						throw new Error("Invalid atomic document selection");
					}

					var selected = Object.create(null);

					keys.forEach(function (selectedKey) {
						Object.defineProperty(selected, selectedKey, {
							value: copy(documents[selectedKey]),
							enumerable: true,
							writable: true,
							configurable: true
						});
					});

					var replacements = update(selected);

					if (
						!replacements ||
						typeof replacements !== "object" ||
						Array.isArray(replacements) ||
						Object.keys(replacements).length !== keys.length ||
						!keys.every(function (selectedKey) {
							return Object.prototype.hasOwnProperty.call(
								replacements, selectedKey
							);
						})
					) {
						throw new Error("Invalid atomic document replacements");
					}

					var next = copy(documents);

					keys.forEach(function (selectedKey) {
						var replacement = replacements[selectedKey];

						if (
							!replacement ||
							typeof replacement !== "object" ||
							Array.isArray(replacement) ||
							replacement.form !== documents[selectedKey].form
						) {
							throw new Error(
								"Atomic updates must preserve document forms"
							);
						}

						Object.defineProperty(next, selectedKey, {
							value: copy(replacement),
							enumerable: true,
							writable: true,
							configurable: true
						});
					});

					// Publish locally only after the writer accepts everything.
					options.replace.replaceAll(next);
					replaceLocalRegistry(next);
				},

				order: function (selection, missionKey, titles) {
					assertPresent();

					var target = documents[key];

					if (!jobViews.isJobTitle(target)) {
						throw new Error("Order recipient is not a job title");
					}

					// Existing establishing-order API.
					if (typeof selection === "string") {
						if (
							!Object.prototype.hasOwnProperty.call(
								documents, selection
							)
						) {
							throw new Error("Unknown contract key");
						}

						var contract = documents[selection];

						if (
							!contract ||
							typeof contract !== "object" ||
							Array.isArray(contract) ||
							contract.form !== "contract"
						) {
							throw new Error("Document is not a contract");
						}

						if (typeof options.order !== "function") {
							throw new Error("Orders are unavailable");
						}

						var transferredMission = null;

						if (missionKey !== undefined) {
							if (
								typeof missionKey !== "string" ||
								!Object.prototype.hasOwnProperty.call(documents, missionKey) ||
								!missions.isMission(documents[missionKey])
							) {
								throw new Error("Selected document is not a mission");
							}

							transferredMission = {
								key: missionKey,
								document: copy(documents[missionKey])
							};
						}

						var titleCopies = [];

						if (titles !== undefined) {
							if (
								!titles ||
								typeof titles !== "object" ||
								Array.isArray(titles)
							) {
								throw new Error("Title selection must be an object");
							}

							Object.keys(titles).forEach(function (destinationKey) {
								var sourceKey = titles[destinationKey];

								if (
									typeof sourceKey !== "string" ||
									!Object.prototype.hasOwnProperty.call(
										documents, sourceKey
									) ||
									!jobViews.isJobTitle(documents[sourceKey])
								) {
									throw new Error("Selected document is not a job title");
								}

								titleCopies.push({
									sourceKey: sourceKey,
									destinationKey: destinationKey,
									title: documents[sourceKey]
								});
							});
						}

						var result = options.order(
							selection,
							target,
							copy(contract),
							transferredMission,
							titleCopies
						);

						result.sourceRemovedKeys.forEach(function (removedKey) {
							delete documents[removedKey];
							generations.delete(removedKey);
							instances.delete(removedKey);
						});

						return;
					}

					// Ordinary order: destination key -> source memo key.
					if (
						!selection ||
						typeof selection !== "object" ||
						Array.isArray(selection)
					) {
						throw new Error("Order selection must be an object");
					}

					if (typeof options.sendOrder !== "function") {
						throw new Error("Ordinary orders are unavailable");
					}

					var registry = Object.create(null);

					if (missionKey !== undefined || titles !== undefined) {
						throw new Error(
							"These arguments require an establishing order"
						);
					}

					Object.keys(selection).forEach(function (destinationKey) {
						var sourceKey = selection[destinationKey];

						if (
							typeof sourceKey !== "string" ||
							!Object.prototype.hasOwnProperty.call(
								documents, sourceKey
							)
						) {
							throw new Error("Unknown source document");
						}

						var document = documents[sourceKey];

						if (
							!document ||
							typeof document !== "object" ||
							Array.isArray(document) ||
							document.form !== "memo"
						) {
							throw new Error("Ordinary orders currently carry only memos");
						}

						registry[destinationKey] = copy(document);
					});

					options.sendOrder(key, target, registry);
				},

				createTitle: function (segment, destinationKey) {
					assertPresent();

					if (
						typeof segment !== "string" ||
						segment.length === 0 ||
						segment === "." ||
						segment === ".." ||
						/[\/\u0000-\u001f\u007f]/.test(segment)
					) {
						throw new Error("Invalid subordinate title segment");
					}

					if (
						typeof destinationKey !== "string" ||
						destinationKey.length === 0
					) {
						throw new Error("Document key must be a non-empty string");
					}

					if (
						Object.prototype.hasOwnProperty.call(
							documents, destinationKey
						)
					) {
						throw new Error(
							"Document key already exists: " + destinationKey
						);
					}

					if (!jobViews.isJobTitle(options.title)) {
						throw new Error("Context has no valid job title");
					}

					if (typeof options.insert !== "function") {
						throw new Error("Context cannot create documents");
					}

					var title = options.title + "/" + segment;

					options.insert(destinationKey, title);

					Object.defineProperty(documents, destinationKey, {
						value: title,
						enumerable: true,
						writable: true,
						configurable: true
					});

					generations.set(destinationKey, {});

					return context.get(destinationKey);
				},

				file: function (destinationKey) {
					assertPresent();

					if (typeof options.file !== "function") {
						throw new Error("Document cannot be filed here");
					}

					return options.file(
						destinationKey,
						copy(documents[key])
					);
				},

				inspectMission: function () {
					assertPresent();

					if (typeof options.readMission !== "function") {
						throw new Error("Mission inspection is unavailable");
					}

					return copy(options.readMission(documents[key]));
				},

				createPart: function (segment, task) {
					assertPresent();

					if (typeof options.createPart !== "function") {
						throw new Error("Project writes are unavailable");
					}

					options.createPart(
						key,
						copy(documents[key]),
						segment,
						task
					);
				},

				createMission: function (segment, destinationKey) {
					assertPresent();

					if (typeof options.createMission !== "function") {
						throw new Error("Mission issuance is unavailable");
					}

					var result = options.createMission(
						key,
						copy(documents[key]),
						segment,
						destinationKey
					);

					replaceLocalRegistry(result.registry);

					return context.get(destinationKey);
				},

				defer: function () {
					assertPresent();

					if (typeof options.defer !== "function") {
						throw new Error("Deferred events are unavailable");
					}

					options.defer();
				},

				report: function (destinationKey, titles) {
					assertPresent();

					if (
						destinationKey !== null &&
						typeof destinationKey === "object"
					) {
						if (Array.isArray(destinationKey) || titles !== undefined) {
							throw new Error("Invalid memo report selection");
						}

						if (typeof options.reportMemos !== "function") {
							throw new Error("Memo reports are unavailable");
						}

						var registry = Object.create(null);

						Object.keys(destinationKey).forEach(function (incomingKey) {
							var sourceKey = destinationKey[incomingKey];

							if (
								typeof sourceKey !== "string" ||
								!Object.prototype.hasOwnProperty.call(
									documents, sourceKey
								)
							) {
								throw new Error("Unknown source document");
							}

							var document = documents[sourceKey];

							if (
								!document ||
								typeof document !== "object" ||
								Array.isArray(document) ||
								document.form !== "memo"
							) {
								throw new Error("Memo reports currently carry only memos");
							}

							registry[incomingKey] = copy(document);
						});

						options.reportMemos(
							key,
							copy(documents[key]),
							registry
						);

						return;
					}

					if (
						typeof destinationKey !== "string" ||
						destinationKey.length === 0
					) {
						throw new Error("Report destination key must be non-empty");
					}

					if (typeof options.returnMission !== "function") {
						throw new Error("Assignment reports are unavailable");
					}

					var titleCopies = [];

					if (titles !== undefined) {
						if (
							!titles ||
							typeof titles !== "object" ||
							Array.isArray(titles)
						) {
							throw new Error("Title selection must be an object");
						}

						Object.keys(titles).forEach(function (incomingKey) {
							var sourceKey = titles[incomingKey];

							if (
								typeof sourceKey !== "string" ||
								!Object.prototype.hasOwnProperty.call(documents, sourceKey) ||
								!jobViews.isJobTitle(documents[sourceKey])
							) {
								throw new Error("Selected document is not a job title");
							}

							titleCopies.push({
								sourceKey: sourceKey,
								destinationKey: incomingKey,
								title: documents[sourceKey]
							});
						});
					}

					var result = options.returnMission(
						key,
						copy(documents[key]),
						destinationKey,
						titleCopies
					);

					result.sourceRemovedKeys.forEach(function (removedKey) {
						delete documents[removedKey];
						generations.delete(removedKey);
						instances.delete(removedKey);
					});
				},

				resign: function () {
					assertPresent();

					if (typeof options.resign !== "function") {
						throw new Error("Resignation is unavailable");
					}

					var result = options.resign(key, copy(documents[key]));

					replaceLocalRegistry(result.registry);
				},

				revokePart: function (segment) {
					assertPresent();

					if (typeof options.revokePart !== "function") {
						throw new Error("Binding revocation is unavailable");
					}

					var result = options.revokePart(
						key,
						copy(documents[key]),
						segment
					);

					replaceLocalRegistry(result.registry);
				},

				replace: function (replacement) {
					assertPresent();

					if (typeof options.replace !== "function") {
						throw new Error("Context is read-only");
					}

					var next = copy(replacement);

					// Publish locally only after successful materialization.
					options.replace(key, next);

					Object.defineProperty(documents, key, {
						value: next,
						enumerable: true,
						writable: true,
						configurable: true
					});
				}
			}));

			if (!instance || typeof instance !== "object") {
				throw new Error("Document factory must return an object");
			}

			instances.set(key, instance);
			return instance;
		}
	});

	return {
		context: context,

		acceptMemo: function (key, document) {
			assertActive();

			if (
				!document ||
				typeof document !== "object" ||
				Array.isArray(document) ||
				document.form !== "memo"
			) {
				throw new Error("Only memos can be filed");
			}

			if (typeof options.replace !== "function") {
				throw new Error("Context is read-only");
			}

			return insertDocument(key, document, function (next) {
				options.replace(key, next, {
					insert: true
				});
			});
		},

		close: function () {
			active = false;
			instances.clear();
			generations.clear();
		}
	};
}

exports.loadForms = loadForms;
exports.openContext = openContext;