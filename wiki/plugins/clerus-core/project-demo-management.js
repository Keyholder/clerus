/*\
title: $:/plugins/clerus/core/project-demo-management.js
type: application/javascript
module-type: library
\*/

"use strict";

var stores = require("$:/plugins/clerus/core/store.js");
var localCustody = require(
	"$:/plugins/clerus/core/local-custody.js"
);

var EXECUTOR = "$:/plugins/clerus/core/project-demo-executor.js";
var SEGMENTS = ["first", "second", "third"];

exports.create = function (options) {
	var wiki = options.wiki;
	var platform = options.platform;
	var newId = options.newId;
	var prefix = "$:/clerus/wal/" + platform + "/";

	var store = new stores.Store({
		wiki: wiki,
		Tiddler: options.Tiddler
	});

	var custody = localCustody.create({
		store: store,
		platform: platform
	});

	function prepare() {
		var project = "Clerus Demo Project " + newId();
		var root = "$:/clerus/jobs/project-demo-root-" + newId();
		var journal = prefix + "project-demo-" + newId();

		var projectFields = {
			title: project,
			type: "application/json",
			"clerus-custody": platform,
			text: JSON.stringify({
				task: {
					purpose: "Compute three squares",
					items: {
						first: 2,
						second: 3,
						third: 5
					}
				},
				parts: {}
			}, null, 2)
		};

		if (
			wiki.tiddlerExists(root) ||
			wiki.isShadowTiddler(root)
		) {
			throw new Error("Generated root title is occupied");
		}

		options.publisher.publish({
			version: 2,
			id: newId(),
			checks: [],
			transitions: [
				stores.transition(project, null, projectFields)
			],
			blocks: [],
			emits: [{
				id: newId(),
				event: {
					kind: "delivery",
					type: "order",
					establishing: true,
					recipient: {
						title: root,
						executor: EXECUTOR
					},
					registry: {
						contract: {
							form: "contract",
							executor: EXECUTOR,
							temp: false,
							book: {
								kind: "project-demo-root",
								project: project
							}
						},
						assignment: {
							form: "mission",
							project: project,
							role: [],
							link: "1",
							issued: "0",
							children: {}
						}
					}
				}
			}]
		}, journal);

		return {
			project: project,
			root: root,
			journal: journal
		};
	}

	function readRoot(title, phase, errorMessage) {
		var current = store.read(title);

		if (
			current.kind !== "materialized" ||
			title.indexOf("$:/clerus/jobs/project-demo-root-") !== 0 ||
			current.fields["clerus-executor"] !== EXECUTOR
		) {
			throw new Error("Select a project demo root");
		}

		var registry = JSON.parse(current.fields.text);

		if (
			!registry.charter ||
			!registry.charter.book ||
			registry.charter.book.kind !== "project-demo-root" ||
			!registry.charter.status ||
			registry.charter.status.phase !== phase
		) {
			throw new Error(errorMessage);
		}

		if (!custody.owns(current.fields)) {
			throw new Error("Project root is not locally owned");
		}

		return current;
	}

	function publishOrder(title, current, journal, registry) {
		options.publisher.publish({
			version: 2,
			id: newId(),
			checks: [{
				title: title,
				state: current.fields
			}],
			transitions: [],
			blocks: [],
			emits: [{
				id: newId(),
				event: {
					kind: "delivery",
					type: "order",
					recipient: {
						title: title,
						executor: EXECUTOR
					},
					registry: registry
				}
			}]
		}, journal);

		return {
			root: title,
			journal: journal
		};
	}

	function resources(title) {
		var current = readRoot(
			title,
			"awaiting-resources",
			"Project is not awaiting resources"
		);

		var contracts = {};

		SEGMENTS.forEach(function (segment) {
			contracts["contract-" + segment] = {
				form: "contract",
				executor: EXECUTOR,
				temp: false,
				book: { kind: "project-demo-worker" }
			};
		});

		var journal = prefix + "project-resources-" + newId();

		return publishOrder(title, current, journal, contracts);
	}

	function close(title) {
		var current = readRoot(
			title,
			"completed",
			"Only a completed project can be closed"
		);

		var journal = prefix + "project-close-" + newId();

		return publishOrder(title, current, journal, {
			control: {
				form: "memo",
				data: { command: "close" }
			}
		});
	}

	return Object.freeze({
		prepare: prepare,
		resources: resources,
		close: close
	});
};