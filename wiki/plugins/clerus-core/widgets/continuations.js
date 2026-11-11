/*\
title: $:/plugins/clerus/core/widgets/continuations.js
type: application/javascript
module-type: widget
\*/

"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;
var view = require("$:/plugins/clerus/core/continuation-view.js");

function text(value) {
	return { type: "text", text: String(value) };
}

function element(tag, children, className) {
	var attributes = {};

	if (className) {
		attributes["class"] = {
			type: "string",
			value: className
		};
	}

	return {
		type: "element",
		tag: tag,
		attributes: attributes,
		children: children || []
	};
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

function details(caption, children) {
	return element("details", [
		element("summary", [text(caption)])
	].concat(children));
}

function json(value) {
	return element("pre", [
		text(JSON.stringify(value, null, 2))
	]);
}

function button(caption, command, title, eventId) {
	var attributes = {
		"$message": { type: "string", value: "tm-clerus" },
		command: { type: "string", value: command },
		title: { type: "string", value: title }
	};

	if (eventId !== undefined) {
		attributes.eventId = {
			type: "string",
			value: eventId
		};
	}

	return {
		type: "button",
		attributes: {},
		children: [
			{
				type: "action-sendmessage",
				attributes: attributes,
				children: []
			},
			text(caption)
		]
	};
}

var STATES = {
	invalid: "Некорректное продолжение",
	work: "Есть принятая работа",
	exhausted: "Нет активной работы и ожидающих событий",
	paused: "Все оставшиеся события приостановлены",
	ready: "Есть готовые события"
};

function eventCard(journal, entry) {
	var event = entry.event;
	var content = [
		element("div", [
			text(entry.mode + " · " + event.kind),
			text(event.kind === "delivery" ? " · " + event.type : "")
		]),
		element("div", [
			text("Идентичность: " + entry.id)
		]),
		element("div", [
			text("Адресат: "),
			link(event.recipient.title)
		])
	];

	if (event.establishing === true) {
		content.push(element("div", [
			text("Учреждающая доставка")
		]));
	}

	if (event.kind === "delivery") {
		content.push(element("div", [
			text(
				"Документов во входящем реестре: " +
				Object.keys(event.registry).length
			)
		]));
	}

	if (entry.retry) {
		content.push(button(
			"Подготовить повтор",
			"retry",
			journal.title,
			entry.id
		));
	}

	content.push(details("Нормативное содержание события", [
		json(event)
	]));

	return element("li", content);
}

function workPreview(preview) {
	var labels = {
		ready: "Ожидает применения",
		"already-applied": "Уже применён",
		"check-failed": "Проверка не прошла"
	};

	var content = [
		element("div", [
			text(preview.applicable
				? "Материальные проверки пакета сейчас проходят."
				: "Материальные проверки пакета сейчас не проходят.")
		]),
		element("div", [
			text("Контрольных снимков: " + preview.checks)
		])
	];

	if (preview.error) {
		content.push(element("div", [
			text(preview.error)
		]));
	}

	content.push(element("ul", preview.transitions.map(function (entry) {
		var row = [
			link(entry.title),
			text(" — " + labels[entry.status])
		];

		if (entry.error) {
			row.push(element("div", [
				text(entry.error)
			]));
		}

		return element("li", row);
	})));

	content.push(element("div", [
		text(
			"Предварительная проверка не блокирует изменения данных " +
			"и не заменяет проверки рантайма при исполнении."
		)
	]));

	return details("Проверка материализации", content);
}

function journalCard(item, platform) {
	var content = [
		element("div", [link(item.title)]),
		element("div", [
			text("Распорядитель: " + item.custody)
		]),
		element("strong", [
			text(STATES[item.state])
		])
	];

	if (item.actions.release) {
		content.push(button(
			"Передать " + platform,
			"release",
			item.title
		));
	}

	if (item.actions.hold) {
		content.push(button(
			"Взять под опеку",
			"hold",
			item.title
		));
	}

	if (item.error) {
		content.push(element("div", [
			text(item.error)
		]));

		return element("div", content, "tc-message-box");
	}

	var record = item.record;

	if (record.retainUntil !== undefined) {
		content.push(element("div", [
			text(
				"Минимальный срок существования WAL, Unix ms: " +
				record.retainUntil
			)
		]));
	}

	if (record.work !== null) {
		content.push(element("div", [
			text(
				"Работа: " + record.work.id +
				". Переходов: " + record.work.transitions.length +
				". Публикуемых событий: " + record.work.emits.length + "."
			)
		]));

		content.push(workPreview(item.workPreview));

		content.push(details("Принятая работа", [
			json(record.work)
		]));
	}

	if (item.events.length > 0) {
		content.push(element("ul", item.events.map(function (entry) {
			return eventCard(item, entry);
		})));
	}

	if (record.diagnostics.length > 0) {
		content.push(details(
			"Диагностика: " + record.diagnostics.length,
			[json(record.diagnostics)]
		));
	}

	return element("div", content, "tc-message-box");
}

function ContinuationsWidget(parseTreeNode, options) {
	this.initialise(parseTreeNode, options);
}

ContinuationsWidget.prototype = new Widget();

ContinuationsWidget.prototype.execute = function () {
	this.platform = $tw.browser ? "browser" : "node";
	this.prefix = "$:/clerus/wal/" + this.platform + "/";

	var content;

	try {
		var items = view.read({
			wiki: this.wiki,
			platform: this.platform,
			Tiddler: $tw.Tiddler
		});

		content = items.length === 0
			? [text("Нет локальных продолжений.")]
			: items.map(function (item) {
				return journalCard(item, this.platform);
			}, this);
	} catch (error) {
		content = [
			text("Не удалось прочитать продолжения: " + error.message)
		];
	}

	this.makeChildWidgets(content);
};

ContinuationsWidget.prototype.render = function (parent, nextSibling) {
	this.parentDomNode = parent;
	this.computeAttributes();
	this.execute();
	this.renderChildren(parent, nextSibling);
};

ContinuationsWidget.prototype.refresh = function (changedTiddlers) {
	var relevant = Object.keys(changedTiddlers).some(function (title) {
		return title.indexOf(this.prefix) === 0;
	}, this);

	if (relevant) {
		this.refreshSelf();
		return true;
	}

	return this.refreshChildren(changedTiddlers);
};

exports["clerus-continuations"] = ContinuationsWidget;