/*\
title: $:/plugins/clerus/core/widgets/resolutions.js
type: application/javascript
module-type: widget
\*/

"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;
var view = require("$:/plugins/clerus/core/resolution-view.js");
var tree = require("$:/plugins/clerus/core/presentation-tree.js");

var text = tree.text;
var element = tree.element;
var link = tree.link;
var details = tree.details;

var LABELS = {
	invalid: "Некорректный тиддлер решения",
	foreign: "Решение другой платформы",
	unconfirmed: "Принятие не подтверждено текущим представлением",
	accepted: "Принятие подтверждено в WAL",
	changed: "Черновик отличается от принятого решения"
};

function attribute(value) {
	return {
		type: "string",
		value: String(value)
	};
}

function editor(title) {
	return {
		type: "tiddler",
		attributes: {
			tiddler: attribute(title)
		},
		children: [{
			type: "edit-text",
			attributes: {
				field: attribute("text"),
				tag: attribute("textarea"),
				rows: attribute("14"),
				"class": attribute("tc-edit-texteditor")
			},
			children: []
		}]
	};
}

function card(item, wiki) {
	var content = [
		element("div", [link(item.title)]),
		element("strong", [
			text(LABELS[item.state] || item.state)
		])
	];

	if (item.journal) {
		content.push(element("div", [
			text("Журнал: "),
			link(item.journal)
		]));
	}

	if (item.eventId) {
		content.push(element("div", [
			text("Событие черновика: " + item.eventId)
		]));
	}

	if (item.error) {
		content.push(element("div", [
			text(item.error)
		]));
	}

	if (item.evidenceError) {
		content.push(element("div", [
			text(
				"Проверка свидетельства: " + item.evidenceError +
				". Это не доказывает, что решение не было принято."
			)
		]));
	}

	if (item.accepted !== null) {
		content.push(element("h4", [
			text("Принято в WAL")
		]));

		content.push(element("div", [
			text("Событие: " + item.accepted.eventId)
		]));

		content.push(tree.json(item.accepted.decision));

		content.push(element("div", [
			text(item.activeAcceptedWork
				? "В WAL есть активная работа этого решения. " +
					"Для материализации отдельно передайте журнал платформе."
				: "Активной работы с идентичностью этого решения " +
					"в журнале сейчас нет. Это не является общей " +
					"проверкой завершения всех его последствий.")
		]));

		content.push(details("Исходное событие — диагностический снимок", [
			tree.json(item.accepted.snapshot)
		]));
	}

	if (item.state === "changed") {
		content.push(element("div", [
			text(
				"Редактирование черновика не изменило принятое решение. " +
				"Прежняя идентичность не может быть использована " +
				"для принятия других распоряжений."
			)
		]));
	}

	if (item.decisionError) {
		content.push(element("div", [
			text("Черновик: " + item.decisionError)
		]));
	}

	var current = wiki.getTiddler(item.title);
	var editable = current &&
		current.fields["clerus-custody"] === "user" &&
		item.state !== "foreign";

	var draft = [
		element("div", [
			text(
				"Это редактируемые пользовательские распоряжения, " +
				"а не отображение принятой работы."
			)
		])
	];

	if (editable) {
		draft.push(editor(item.title));
	} else {
		draft.push(tree.json(
			item.request === null
				? current && current.fields.text
				: item.request
		));
	}

	content.push(details("Черновик решения", draft));

	if (item.canAccept) {
		content.push(tree.commandButton(
			"Принять распоряжение в WAL",
			"accept-resolution",
			item.title
		));

		content.push(element("div", [
			text(
				"Принятие не запускает материализацию. " +
				"Команда повторно проверяет полномочия и применимость."
			)
		]));
	} else if (item.state === "unconfirmed") {
		content.push(element("div", [
			text(
				"Принятие через эту карточку сейчас недоступно. " +
				"Проверьте распоряжения, приписку журнала и состояние события."
			)
		]));
	}

	return element("div", content, "tc-message-box");
}

function ResolutionsWidget(parseTreeNode, options) {
	this.initialise(parseTreeNode, options);
}

ResolutionsWidget.prototype = new Widget();

ResolutionsWidget.prototype.execute = function () {
	this.platform = $tw.browser ? "browser" : "node";
	this.dependencies = new Set();

	var content;

	try {
		var items = view.read({
			wiki: this.wiki,
			platform: this.platform
		});

		items.forEach(function (item) {
			item.dependencies.forEach(function (title) {
				this.dependencies.add(title);
			}, this);
		}, this);

		content = items.length === 0
			? [text("Нет подготовленных решений.")]
			: items.map(function (item) {
				return card(item, this.wiki);
			}, this);
	} catch (error) {
		content = [
			text("Не удалось прочитать решения: " + error.message)
		];
	}

	this.makeChildWidgets(content);
};

ResolutionsWidget.prototype.render = function (parent, nextSibling) {
	this.parentDomNode = parent;
	this.computeAttributes();
	this.execute();
	this.renderChildren(parent, nextSibling);
};

ResolutionsWidget.prototype.refresh = function (changedTiddlers) {
	var relevant = Object.keys(changedTiddlers).some(function (title) {
		return title.indexOf("$:/clerus/resolutions/") === 0 ||
			this.dependencies.has(title);
	}, this);

	if (relevant) {
		this.refreshSelf();
		return true;
	}

	return this.refreshChildren(changedTiddlers);
};

exports["clerus-resolutions"] = ResolutionsWidget;