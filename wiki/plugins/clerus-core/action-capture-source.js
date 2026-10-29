/*\
title: $:/plugins/clerus/core/action-capture-source.js
type: application/javascript
module-type: widget
\*/

"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;
var snapshots = require("$:/plugins/clerus/core/source-snapshot.js");
var bundles =
	require("$:/plugins/clerus/core/source-bundle.js");

function ActionCaptureSource(parseTreeNode, options) {
	this.initialise(parseTreeNode, options);
}

ActionCaptureSource.prototype = new Widget();

ActionCaptureSource.prototype.render = function (parent, nextSibling) {
	this.parentDomNode = parent;
	this.computeAttributes();
	this.execute();
	this.renderChildren(parent, nextSibling);
};

ActionCaptureSource.prototype.execute = function () {
	this.stateTitle = this.getAttribute(
		"$state",
		"$:/temp/clerus/ui/launch"
	);

	this.sourceTitle = this.getAttribute("$title", undefined);
	this.prompt = this.getAttribute("$prompt", undefined);
	this.bundle = this.getAttribute("$bundle", "no") === "yes";

	this.makeChildWidgets();
};

ActionCaptureSource.prototype.refresh = function (changedTiddlers) {
	var changedAttributes = this.computeAttributes();

	if (
		changedAttributes["$state"] ||
		changedAttributes["$title"] ||
		changedAttributes["$prompt"] ||
		changedAttributes["$bundle"]
	) {
		this.refreshSelf();
		return true;
	}

	return this.refreshChildren(changedTiddlers);
};

ActionCaptureSource.prototype.invokeAction = function () {
	var wiki = this.wiki;
	var stateTitle = this.stateTitle;
	var state = wiki.getTiddler(stateTitle);

	function update(fields) {
		wiki.addTiddler(new $tw.Tiddler(
			wiki.getTiddler(stateTitle),
			{ title: stateTitle },
			fields
		));
	}

	try {
		if (!$tw.browser || wiki !== $tw.wiki) {
			throw new Error("Capture requires the active browser wiki");
		}

		var selected = this.sourceTitle !== undefined
			? this.sourceTitle
			: state
				? state.fields["system-source"]
				: undefined;

		var result;

		if (this.bundle) {
			if (typeof selected !== "string") {
				throw new Error("Enter system source titles, one per line");
			}

			var titles = selected.split(/\r?\n/).filter(function (title) {
				return title.length > 0;
			});

			result = bundles.capture($tw, { titles: titles });
		} else {
			result = snapshots.capture($tw, { title: selected });
		}

		var fields = {
			source: result.title,
			"system-source": selected,
			error: ""
		};

		if (this.prompt !== undefined) {
			fields.prompt = this.prompt;
		}

		update(fields);
	} catch (error) {
		update({
			error: String(error && error.message || error)
		});
	}

	return true;
};

exports["action-clerus-capture-source"] = ActionCaptureSource;