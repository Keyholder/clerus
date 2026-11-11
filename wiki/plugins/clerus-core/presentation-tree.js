/*\
title: $:/plugins/clerus/core/presentation-tree.js
type: application/javascript
module-type: library
\*/

"use strict";

function stringAttribute(value) {
	return {
		type: "string",
		value: String(value)
	};
}

function text(value) {
	return {
		type: "text",
		text: String(value)
	};
}

function element(tag, children, className) {
	var attributes = {};

	if (className) {
		attributes["class"] = stringAttribute(className);
	}

	return {
		type: "element",
		tag: tag,
		attributes: attributes,
		children: children ? children.slice() : []
	};
}

function link(title) {
	return {
		type: "link",
		attributes: {
			to: stringAttribute(title)
		},
		children: [text(title)]
	};
}

function details(caption, children) {
	return element("details", [
		element("summary", [text(caption)])
	].concat(children || []));
}

function json(value, limit) {
	var serialized = JSON.stringify(value, null, 2);

	if (serialized === undefined) {
		serialized = "undefined";
	}

	if (limit !== undefined) {
		if (!Number.isSafeInteger(limit) || limit < 1) {
			throw new Error("JSON display limit must be a positive integer");
		}

		if (serialized.length > limit) {
			serialized = serialized.slice(0, limit) + "\n…";
		}
	}

	return element("pre", [text(serialized)]);
}

function commandButton(caption, command, title, eventId) {
	var attributes = {
		"$message": stringAttribute("tm-clerus"),
		command: stringAttribute(command),
		title: stringAttribute(title)
	};

	if (eventId !== undefined) {
		attributes.eventId = stringAttribute(eventId);
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

exports.text = text;
exports.element = element;
exports.link = link;
exports.details = details;
exports.json = json;
exports.commandButton = commandButton;