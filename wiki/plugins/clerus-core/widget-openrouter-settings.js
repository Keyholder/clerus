/*\
title: $:/plugins/clerus/core/widget-openrouter-settings.js
type: application/javascript
module-type: widget
\*/

"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;

function OpenRouterSettings(parseTreeNode, options) {
	this.initialise(parseTreeNode, options);
}

OpenRouterSettings.prototype = new Widget();

OpenRouterSettings.prototype.render = function (parent, nextSibling) {
	this.parentDomNode = parent;
	this.computeAttributes();
	this.execute();

	var document = this.document;
	var root = document.createElement("div");
	root.setAttribute("class", "clerus-openrouter-settings");

	function append(parentNode, tag, text) {
		var node = document.createElement(tag);

		if (text !== undefined) {
			node.appendChild(document.createTextNode(text));
		}

		parentNode.appendChild(node);
		return node;
	}

	append(root, "h3", "OpenRouter");

	var credentials = $tw.browser &&
		$tw.clerus &&
		$tw.clerus.browserCredentials;

	if (!credentials) {
		append(
			root,
			"p",
			"Настройка доступна в браузере после запуска Clerus."
		);

		parent.insertBefore(root, nextSibling);
		this.domNodes.push(root);
		return;
	}

	var keyLabel = append(root, "label", "API-ключ ");
	var input = append(keyLabel, "input");

	input.setAttribute("type", "password");
	input.setAttribute("autocomplete", "off");
	input.setAttribute("spellcheck", "false");
	input.setAttribute("autocapitalize", "off");
	input.setAttribute("aria-label", "OpenRouter API-ключ");

	append(root, "br");

	var persistentLabel = append(root, "label");
	var persistent = append(persistentLabel, "input");

	persistent.setAttribute("type", "checkbox");

	persistentLabel.appendChild(document.createTextNode(
		" Сохранять между сеансами"
	));

	var actions = append(root, "p");
	var save = append(actions, "button", "Сохранить");
	var clear = append(actions, "button", "Удалить ключ");

	save.setAttribute("type", "button");
	clear.setAttribute("type", "button");

	var message = append(root, "p");
	message.setAttribute("role", "status");
	message.setAttribute("aria-live", "polite");

	function announce(text) {
		while (message.firstChild) {
			message.removeChild(message.firstChild);
		}

		message.appendChild(document.createTextNode(text));
	}

	save.addEventListener("click", function () {
		if (!input.value.trim() || /[\r\n]/.test(input.value)) {
			announce("Введите непустой ключ без переносов строк.");
			return;
		}

		try {
			credentials.setApiKey(input.value, persistent.checked);
			input.value = "";

			announce(persistent.checked
				? "Ключ сохранён между сеансами."
				: "Ключ сохранён на текущий сеанс вкладки.");
		} catch (error) {
			// Do not display arbitrary errors or credential values.
			announce(
				"Не удалось сохранить ключ. " +
				"Проверьте разрешения браузерного хранилища."
			);
		}
	});

	clear.addEventListener("click", function () {
		input.value = "";

		try {
			credentials.clear();
			announce("Ключ удалён из обоих хранилищ.");
		} catch (error) {
			announce(
				"Не удалось подтвердить полное удаление ключа. " +
				"Проверьте хранилище сайта в настройках браузера."
			);
		}
	});

	append(
		root,
		"p",
		"Ключ не записывается в тиддлеры. " +
		"Скрипты и плагины того же origin могут прочитать его " +
		"из браузерного хранилища. " +
		"Другие вики на том же origin используют эту же настройку."
	);

	append(
		root,
		"p",
		"Сохранение ключа не отправляет запрос и не повторяет " +
		"ранее завершившиеся вызовы."
	);

	parent.insertBefore(root, nextSibling);
	this.domNodes.push(root);
};

OpenRouterSettings.prototype.execute = function () {};

OpenRouterSettings.prototype.refresh = function () {
	/*
	Unrelated wiki changes must not replace the password field,
	erase an unfinished input or copy its value into widget state.
	*/
	return false;
};

exports["clerus-openrouter-settings"] = OpenRouterSettings;