/*\
title: $:/plugins/clerus/core/widget-job-status.js
type: application/javascript
module-type: widget
\*/

"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;

function JobStatus(parseTreeNode, options) {
	this.initialise(parseTreeNode, options);
}

JobStatus.prototype = new Widget();

JobStatus.prototype.render = function (parent, nextSibling) {
	this.parentDomNode = parent;
	this.computeAttributes();
	this.execute();

	var root = this.document.createElement("div");
	root.setAttribute("class", "clerus-job-status");

	function text(document, parentNode, tag, value) {
		var node = document.createElement(tag);
		node.appendChild(document.createTextNode(value));
		parentNode.appendChild(node);
	}

	var tiddler = this.wiki.getTiddler(this.title);

	if (!tiddler) {
		text(this.document, root, "p", "Должность отсутствует.");
	} else {
		text(
			this.document,
			root,
			"p",
			"Распорядитель: " +
				(tiddler.fields["clerus-custody"] || "user")
		);

		try {
			var registry = JSON.parse(tiddler.fields.text);

			if (
				!registry ||
				typeof registry !== "object" ||
				Array.isArray(registry)
			) {
				throw new Error("Invalid registry");
			}

			var charters = Object.keys(registry).map(function (key) {
				return registry[key];
			}).filter(function (document) {
				return document &&
					typeof document === "object" &&
					!Array.isArray(document) &&
					document.form === "charter";
			});

			if (
				charters.length !== 1 ||
				!Object.prototype.hasOwnProperty.call(
					charters[0], "status"
				)
			) {
				throw new Error("Invalid charter");
			}

			var status = charters[0].status;

			if (
				status &&
				typeof status === "object" &&
				typeof status.phase === "string"
			) {
				text(
					this.document,
					root,
					"p",
					"Состояние: " + status.phase
				);
			}

			if (
				status &&
				typeof status === "object" &&
				status.phase === "completed" &&
				typeof status.result === "string" &&
				status.result
			) {
				var resultLine = this.document.createElement("p");
				root.appendChild(resultLine);

				/*
				Use TW's link widget rather than building a navigation URL.
				The target is an attribute value, not parsed wikitext.
				*/
				this.makeChildWidgets([{
					type: "link",
					attributes: {
						to: {
							type: "string",
							value: status.result
						}
					},
					children: [{
						type: "text",
						text: "Открыть результат"
					}]
				}]);

				this.children.forEach(function (child) {
					child.render(resultLine, null);
				});
			}

			if (
				status &&
				typeof status === "object" &&
				typeof status.message === "string"
			) {
				text(this.document, root, "p", status.message);
			}

			text(
				this.document,
				root,
				"pre",
				JSON.stringify(status, null, 2)
			);
		} catch (error) {
			text(
				this.document,
				root,
				"p",
				"Публичный статус недоступен: " +
					"не удалось прочитать реестр или устав."
			);
		}
	}

	parent.insertBefore(root, nextSibling);
	this.domNodes.push(root);
};

JobStatus.prototype.execute = function () {
	this.title = this.getAttribute("title", "");
	this.makeChildWidgets([]);
};

JobStatus.prototype.refresh = function (changedTiddlers) {
	var changedAttributes = this.computeAttributes();

	if (changedAttributes.title || changedTiddlers[this.title]) {
		this.refreshSelf();
		return true;
	}

	return false;
};

exports["clerus-job-status"] = JobStatus;