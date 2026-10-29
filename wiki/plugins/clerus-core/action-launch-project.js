/*\
title: $:/plugins/clerus/core/action-launch-project.js
type: application/javascript
module-type: widget
\*/

"use strict";

var Widget = require("$:/core/modules/widgets/widget.js").widget;
var launcher = require("$:/plugins/clerus/core/project-launch.js");

function ActionLaunchProject(parseTreeNode, options) {
	this.initialise(parseTreeNode, options);
}

ActionLaunchProject.prototype = new Widget();

ActionLaunchProject.prototype.render = function (parent, nextSibling) {
	this.parentDomNode = parent;
	this.computeAttributes();
	this.execute();
	this.renderChildren(parent, nextSibling);
};

ActionLaunchProject.prototype.execute = function () {
	this.stateTitle = this.getAttribute(
		"$state",
		"$:/temp/clerus/ui/launch"
	);

	this.mode = this.getAttribute("$mode", "probe");
	this.makeChildWidgets();
};

ActionLaunchProject.prototype.refresh = function (changedTiddlers) {
	var changedAttributes = this.computeAttributes();

	if (changedAttributes["$state"] || changedAttributes["$mode"]) {
		this.refreshSelf();
		return true;
	}

	return this.refreshChildren(changedTiddlers);
};

ActionLaunchProject.prototype.invokeAction = function () {
	var wiki = this.wiki;
	var title = this.stateTitle;
	var state = wiki.getTiddler(title);

	function update(fields) {
		wiki.addTiddler(new $tw.Tiddler(
			wiki.getTiddler(title),
			{ title: title },
			fields
		));
	}

	try {
		if (wiki !== $tw.wiki) {
			throw new Error("Launch requires the active application wiki");
		}

		var result = launcher.launch($tw, {
			mode: this.mode,
			prompt: state ? state.fields.prompt : undefined,
			model: state ? state.fields.model : undefined,
			sourceTitle: state ? state.fields.source : undefined,
			maxTokens: state ? state.fields["max-tokens"] : undefined
		});

		update({
			project: result.project,
			job: result.job,
			error: ""
		});
	} catch (error) {
		update({
			error: String(error && error.message || error)
		});
	}

	return true;
};

exports["action-clerus-launch-project"] = ActionLaunchProject;