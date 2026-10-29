/*\
title: $:/plugins/clerus/core/documents-basic.js
type: application/javascript
module-type: clerus-document
\*/

"use strict";

var copyJSON = require("$:/plugins/clerus/core/json.js").copy;

exports.forms = {
	charter: function (access) {
		return Object.freeze({
			book: function () {
				return access.read().book;
			},

			createTitle: function (segment, key) {
				return access.createTitle(segment, key);
			},

			status: function () {
				return access.read().status;
			},

			defer: function () {
				access.defer();
			},

			setStatus: function (status) {
				var document = access.read();

				document.status = copyJSON(status);
				access.replace(document);
			}
		});
	},

	memo: function (access) {
		return Object.freeze({
			file: function (destinationKey) {
				return access.file(destinationKey);
			},

			data: function () {
				return access.read().data;
			},

			setData: function (data) {
				var document = access.read();

				document.data = copyJSON(data);
				access.replace(document);
			}
		});
	},

	"tiddler-title": function (access) {
		return Object.freeze({
			inspect: function () {
				return access.inspectTiddler();
			},

			field: function (name) {
				if (typeof name !== "string") {
					throw new Error("Field name must be a string");
				}

				var view = access.inspectTiddler();

				if (!view.exists) {
					throw new Error("Tiddler does not exist");
				}

				return Object.prototype.hasOwnProperty.call(view.fields, name)
					? view.fields[name]
					: undefined;
			},

			text: function () {
				var view = access.inspectTiddler();

				if (!view.exists) {
					throw new Error("Tiddler does not exist");
				}

				return Object.prototype.hasOwnProperty.call(view.fields, "text")
					? view.fields.text
					: "";
			},

			patch: function (warrantKey, patch) {
				access.writeTiddler("patch", warrantKey, patch);
			},

			delete: function (warrantKey) {
				access.writeTiddler("delete", warrantKey);
			}
		});
	},

	"job-title": function (access) {
		return Object.freeze({
			inspect: function () {
				return access.inspectJob();
			},

			order: function (selection, missionKey, titles) {
				return access.order(selection, missionKey, titles);
			},

			status: function () {
				var view = access.inspectJob();

				if (!view.readable) {
					throw new Error("Target job status is unavailable");
				}

				return view.status;
			}
		});
	},

	mission: function (access) {
		return Object.freeze({
			inspect: function () {
				return access.inspectMission();
			},

			createPart: function (segment, task) {
				access.createPart(segment, task);
			},

			createMission: function (segment, destinationKey) {
				return access.createMission(segment, destinationKey);
			},

			report: function (destinationKey, titles) {
				access.report(destinationKey, titles);
			},

			resign: function () {
				access.resign();
			},

			revokePart: function (segment) {
				access.revokePart(segment);
			},

			task: function () {
				var view = access.inspectMission();

				if (!view.readable) {
					throw new Error(view.reason || "Task is unavailable");
				}

				return view.task;
			}
		});
	},

	contract: function (access) {
		return Object.freeze({
			executor: function () {
				return access.read().executor;
			},

			book: function () {
				return access.read().book;
			}
		});
	}
};

exports.rules = {
	charter: {
		transfer: "never",
		receipt: "automatic",
		messages: []
	},

	memo: {
		transfer: "copy",
		receipt: "explicit",
		messages: ["order", "report"]
	},

	"tiddler-title": {
		transfer: "copy",
		receipt: "automatic",
		messages: ["order", "report"]
	},

	"job-title": {
		transfer: "copy",
		receipt: "automatic",
		messages: ["order", "report"]
	},

	mission: {
		transfer: "move",
		receipt: "automatic",
		messages: ["order", "report"]
	},

	contract: {
		transfer: "move",
		receipt: "automatic",
		messages: ["order"],
		establishingOnly: true,

		transform: function (document) {
			var charter = {
				form: "charter",
				status: { phase: "created" }
			};

			if (Object.prototype.hasOwnProperty.call(document, "book")) {
				charter.book = document.book;
			}

			return charter;
		}
	}
};