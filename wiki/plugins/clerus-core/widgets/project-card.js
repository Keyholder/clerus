/*\
title: $:/plugins/clerus/core/widgets/project-card.js
type: application/javascript
module-type: widget
\*/

"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;
var cards = require("$:/plugins/clerus/core/project-card.js");

function text(value) {
	return {
		type: "text",
		text: String(value)
	};
}

function element(tag, children, className) {
	var result = {
		type: "element",
		tag: tag,
		children: children || [],
		attributes: {}
	};

	if (className) {
		result.attributes["class"] = {
			type: "string",
			value: className
		};
	}

	return result;
}

function link(title) {
	return {
		type: "link",
		attributes: {
			to: { type: "string", value: title }
		},
		children: [text(title)]
	};
}

function json(value) {
	var serialized = JSON.stringify(value, null, 2);

	if (serialized === undefined) {
		serialized = "undefined";
	}

	if (serialized.length > 4000) {
		serialized = serialized.slice(0, 4000) + "\n…";
	}

	return element("pre", [text(serialized)]);
}

function details(caption, content) {
	return element("details", [
		element("summary", [text(caption)])
	].concat(content));
}

function commandButton(caption, command, title) {
	return {
		type: "button",
		attributes: {},
		children: [
			{
				type: "action-sendmessage",
				attributes: {
					"$message": {
						type: "string",
						value: "tm-clerus"
					},
					command: {
						type: "string",
						value: command
					},
					title: {
						type: "string",
						value: title
					}
				},
				children: []
			},
			text(caption)
		]
	};
}

function holder(view) {
	var content = [
		element("div", [link(view.title)]),
		element("div", [
			text(
				"Приписка: " + view.custody + ". " +
				(view.locallyOwned
					? "Локальное распорядительство."
					: "Локальное распорядительство не установлено; " +
						"показан известный слепок.")
			)
		])
	];

	if (view.view.readable) {
		content.push(details("Рабочий статус", [
			json(view.view.status)
		]));
	} else {
		content.push(element("div", [
			text("Статус недоступен: " + view.view.reason)
		]));
	}

	if (view.suspended) {
		content.push(element("div", [
			text("Должность отстранена.")
		]));
	}

	var controls = [];

	if (view.actions.prepareMove) {
		controls.push(commandButton(
			"Подготовить переезд в " + view.actions.destination,
			"prepare-move",
			view.title
		));
	}

	if (view.actions.resume) {
		controls.push(commandButton(
			"Возобновить на текущей платформе",
			"resume",
			view.title
		));
	}

	if (controls.length > 0) {
		content.push(element(
			"div",
			controls,
			"clerus-project-card-actions"
		));
	}

	return content;
}

function taskNode(node) {
	var content = [
		element("strong", [
			text(node.role.length === 0
				? "Корневая задача"
				: node.role[node.role.length - 1])
		]),
		details("Конфигурация задачи", [json(node.task)])
	];

	if (node.error) {
		content.push(element("div", [text(node.error)]));
	}

	if (node.assignment) {
		content = content.concat(holder(node.assignment.holder));
		content.push(element("div", [
			text("Поколение назначения: " + node.assignment.link)
		]));
	} else {
		content.push(element("div", [
			text("Актуальное назначение не установлено.")
		]));
	}

	var inactive = node.entries.filter(function (entry) {
		return !entry.active;
	});

	if (inactive.length > 0) {
		content.push(details("Неактуальные записи назначений", [
			json(inactive)
		]));
	}

	if (node.children.length > 0) {
		content.push(element("ul", node.children.map(taskNode)));
	}

	return element("li", content);
}

function ProjectCardWidget(parseTreeNode, options) {
	this.initialise(parseTreeNode, options);
}

ProjectCardWidget.prototype = new Widget();

ProjectCardWidget.prototype.execute = function () {
	this.project = this.getAttribute(
		"project",
		this.getVariable("currentTiddler")
	);

	var content;

	try {
		var model = cards.read({
			wiki: this.wiki,
			Tiddler: $tw.Tiddler,
			platform: $tw.browser ? "browser" : "node",
			project: this.project
		});

		content = [
			element("div", [link(model.project)])
		];

		if (model.projectCustody !== null) {
			content.push(element("div", [
				text(
					"Приписка проекта: " + model.projectCustody + ". " +
					(model.projectLocallyOwned
						? "Проект под локальным распорядительством."
						: "Локальное распорядительство проектом не установлено.")
				)
			]));
		}

		if (model.error) {
			content.push(element("div", [text(model.error)]));
		}

		if (
			!model.organization.complete ||
			!model.organization.valid
		) {
			content.push(element("div", [
				text(
					"Организационная перспектива неполна или содержит " +
					"нарушения. Отсутствие актуального назначения " +
					"не следует трактовать как отсутствие документов."
				)
			]));
		}

		if (model.tree) {
			content.push(element("ul", [taskNode(model.tree)]));
		}

		if (model.outsideTree.length > 0) {
			var outside = [];

			model.outsideTree.forEach(function (entry) {
				outside.push(element("div", [
					text("Роль: " + JSON.stringify(entry.role))
				]));

				outside = outside.concat(holder(entry.holder));
			});

			content.push(details(
				"Актуальные назначения вне отображённого дерева",
				outside
			));
		}

		if (
			!model.organization.complete ||
			!model.organization.valid
		) {
			content.push(details(
				"Диагностика организационной перспективы",
				[json(model.organization)]
			));
		}
	} catch (error) {
		/*
		Infrastructure failures are displayed as failures,
		not interpreted as absence of assignments.
		*/
		content = [
			element("div", [
				text("Не удалось построить карточку: " + error.message)
			])
		];
	}

	this.makeChildWidgets([
		element("div", content, "clerus-project-card")
	]);
};

ProjectCardWidget.prototype.render = function (parent, nextSibling) {
	this.parentDomNode = parent;
	this.computeAttributes();
	this.execute();
	this.renderChildren(parent, nextSibling);
};

ProjectCardWidget.prototype.refresh = function (changedTiddlers) {
	var attributes = this.computeAttributes();

	var relevant = Object.keys(changedTiddlers).some(function (title) {
		return title === this.project ||
			title.indexOf("$:/clerus/jobs/") === 0 ||
			title.indexOf("$:/temp/clerus/jobs/") === 0 ||
			title.indexOf("$:/clerus/wal/") === 0 ||
			title.indexOf("$:/clerus/custody/") === 0;
	}, this);

	var currentProject = this.getAttribute(
		"project",
		this.getVariable("currentTiddler")
	);

	if (
		attributes.project ||
		currentProject !== this.project ||
		relevant
	) {
		this.refreshSelf();
		return true;
	}

	return this.refreshChildren(changedTiddlers);
};

exports["clerus-project-card"] = ProjectCardWidget;