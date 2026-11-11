/*\
title: $:/plugins/clerus/core/widgets/retention.js
type: application/javascript
module-type: widget
\*/

"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;
var view = require("$:/plugins/clerus/core/retention-view.js");
var tree = require("$:/plugins/clerus/core/presentation-tree.js");

var text = tree.text;
var element = tree.element;
var link = tree.link;
var details = tree.details;

var LABELS = {
	"active-mission": "Актуальное назначение",
	"operational-reference": "Тайтл в чужом операционном реестре",
	"accepted-work": "Принятая незавершённая работа",
	"waiting-event": "Ожидающее или приостановленное событие",
	"planned-event": "Запланированное событие",
	"transactional-reference": "Тайтл в транзакционном реестре",
	"planned-operational-reference": "Тайтл в предписанном реестре",
	"pending-establishment": "Ожидающее учреждение",
	"pending-message": "Ожидающее сообщение",
	"accepted-birth": "Принятое учреждение",
	"accepted-plan-owner": "Владелец принятого плана",
	"planned-deferred-event": "Запланированная активация",
	"deferred-event": "Ожидающая активация"
};

function reasonNode(reason) {
	return element("li", [
		text(LABELS[reason.kind] || reason.kind),
		details("Основание", [
			element("pre", [
				text(JSON.stringify(reason, null, 2))
			])
		])
	]);
}

function jobNode(job, model) {
	var description;

	if (job.reasons.length > 0) {
		description = "Есть основания удержания.";
	} else if (!model.complete || !model.valid) {
		description = "Явных удержаний не найдено, но безопасный анализ заблокирован.";
	} else if (!job.locallyOwned) {
		description = "Явных удержаний не найдено; должность не под локальным распорядительством.";
	} else if (job.analysisCandidate) {
		description = "Кандидат анализа. Окончательные проверки выполняет сборщик.";
	} else {
		description = "Не является кандидатом текущего анализа.";
	}

	var content = [
		element("div", [link(job.title)]),
		element("div", [
			text("Приписка: " + job.custody + ". " + description)
		])
	];

	if (job.reasons.length > 0) {
		content.push(element("ul", job.reasons.map(reasonNode)));
	}

	return element("li", content);
}

function RetentionWidget(parseTreeNode, options) {
	this.initialise(parseTreeNode, options);
}

RetentionWidget.prototype = new Widget();

RetentionWidget.prototype.execute = function () {
	var content;

	try {
		var model = view.read({
			wiki: this.wiki,
			Tiddler: $tw.Tiddler,
			platform: $tw.browser ? "browser" : "node"
		});

		content = [
			element("div", [
				text(
					"Полнота анализа: " + model.complete +
					". Корректность организации: " + model.valid + "."
				)
			]),
			element("div", [
				text(
					"Представление не учитывает все эфемерные барьеры " +
					"рантайма и не является разрешением на удаление."
				)
			])
		];

		if (model.incomplete.length > 0) {
			content.push(details("Причины неполноты", [
				element("pre", [
					text(JSON.stringify(model.incomplete, null, 2))
				])
			]));
		}

		if (!model.valid) {
			content.push(element("div", [
				text(
					"Организация некорректна. Подробности доступны " +
					"в инспекции рантайма."
				)
			]));
		}

		content.push(element("ul", model.jobs.map(function (job) {
			return jobNode(job, model);
		})));
	} catch (error) {
		content = [
			element("div", [
				text("Не удалось вычислить живость: " + error.message)
			])
		];
	}

	this.makeChildWidgets([
		element("div", content)
	]);
};

RetentionWidget.prototype.render = function (parent, nextSibling) {
	this.parentDomNode = parent;
	this.computeAttributes();
	this.execute();
	this.renderChildren(parent, nextSibling);
};

RetentionWidget.prototype.refresh = function (changedTiddlers) {
	var relevant = Object.keys(changedTiddlers).some(function (title) {
		return title.indexOf("$:/clerus/jobs/") === 0 ||
			title.indexOf("$:/temp/clerus/jobs/") === 0 ||
			title.indexOf("$:/clerus/wal/") === 0 ||
			title.indexOf("$:/clerus/custody/") === 0;
	});

	if (relevant) {
		this.refreshSelf();
		return true;
	}

	return this.refreshChildren(changedTiddlers);
};

exports["clerus-retention"] = RetentionWidget;