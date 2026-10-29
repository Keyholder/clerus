/*\
title: $:/plugins/clerus/core/state.js
type: application/javascript
module-type: library
\*/

"use strict";

var effects = require("$:/plugins/clerus/core/effects.js");

exports.live = function (wiki, Tiddler) {
	return Object.freeze({
		mode: "live",

		getTiddler: function (title) {
			return wiki.getTiddler(title);
		},

		apply: function (effect) {
			return effects.apply(wiki, Tiddler, effect);
		}
	});
};

exports.planned = function (plan) {
	return Object.freeze({
		mode: "planned",

		creation: function (title) {
			return plan.creation(title);
		},

		rememberCreation: function (title, origin) {
			plan.rememberCreation(title, origin);
		},

		getTiddler: function (title) {
			return plan.view.getTiddler(title);
		},

		apply: function (effect) {
			return plan.apply(effect);
		}
	});
};