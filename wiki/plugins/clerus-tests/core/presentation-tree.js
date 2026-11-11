/*\
title: $:/plugins/clerus/tests/core/presentation-tree.js
type: application/javascript
module-type: library
\*/

"use strict";

var tree = require("$:/plugins/clerus/core/presentation-tree.js");

function assert(condition, message) {
	if (!condition) {
		throw new Error(message || "Assertion failed");
	}
}

function testTextIsNotParsed() {
	var source = "<script>sentinel</script>";
	var node = tree.text(source);

	assert(node.type === "text");
	assert(node.text === source);
	assert(node.children === undefined);
}

function testElementDoesNotReuseChildrenArray() {
	var children = [tree.text("first")];
	var node = tree.element("div", children, "example");

	children.push(tree.text("second"));

	assert(node.children.length === 1);
	assert(node.attributes["class"].value === "example");
}

function testLinkUsesLiteralAttribute() {
	var title = 'Title with "quotes" and <$widgets>';
	var node = tree.link(title);

	assert(node.type === "link");
	assert(node.attributes.to.type === "string");
	assert(node.attributes.to.value === title);
	assert(node.children[0].type === "text");
	assert(node.children[0].text === title);
}

function testCommandButtonContainsStandardAction() {
	var node = tree.commandButton(
		"Retry",
		"retry",
		"$:/clerus/wal/browser/example",
		"presentation-event-0001"
	);

	assert(node.type === "button");

	var action = node.children[0];

	assert(action.type === "action-sendmessage");
	assert(action.attributes["$message"].value === "tm-clerus");
	assert(action.attributes.command.value === "retry");
	assert(
		action.attributes.title.value ===
			"$:/clerus/wal/browser/example"
	);
	assert(
		action.attributes.eventId.value ===
			"presentation-event-0001"
	);
	assert(node.children[1].text === "Retry");

	var withoutEvent = tree.commandButton(
		"Hold",
		"hold",
		"$:/clerus/wal/browser/example"
	);

	assert(
		!Object.prototype.hasOwnProperty.call(
			withoutEvent.children[0].attributes,
			"eventId"
		)
	);
}

function testJsonLimitDoesNotChangeSource() {
	var source = {
		message: "<script>sentinel</script>",
		long: "x".repeat(100)
	};

	var before = JSON.stringify(source);
	var full = tree.json(source);
	var limited = tree.json(source, 20);

	assert(full.tag === "pre");
	assert(full.children[0].type === "text");
	assert(
		full.children[0].text === JSON.stringify(source, null, 2)
	);
	assert(limited.children[0].text.endsWith("\n…"));
	assert(JSON.stringify(source) === before);
}

function testCallsDoNotShareActionAttributes() {
	var first = tree.commandButton("First", "hold", "first");
	var second = tree.commandButton("Second", "hold", "second");

	first.children[0].attributes.title.value = "modified";

	assert(
		second.children[0].attributes.title.value === "second"
	);
}

exports.run = function () {
	var cases = [
		["presentation: text remains a text node", testTextIsNotParsed],
		["presentation: element copies the children array", testElementDoesNotReuseChildrenArray],
		["presentation: links use literal titles", testLinkUsesLiteralAttribute],
		["presentation: command button uses standard action widget", testCommandButtonContainsStandardAction],
		["presentation: JSON clipping does not mutate data", testJsonLimitDoesNotChangeSource],
		["presentation: generated actions do not share attributes", testCallsDoNotShareActionAttributes]
	];

	var results = cases.map(function (item) {
		try {
			item[1]();

			return {
				name: item[0],
				passed: true,
				error: null
			};
		} catch (error) {
			return {
				name: item[0],
				passed: false,
				error: String(error.stack || error)
			};
		}
	});

	return {
		passed: results.every(function (result) {
			return result.passed;
		}),
		results: results
	};
};