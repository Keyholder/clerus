/*\
title: $:/plugins/clerus/core/documents/warrant.js
type: application/javascript
module-type: library
\*/

"use strict";

exports.create = function (access) {
	return Object.freeze({
		declaration: function () {
			return access.read();
		},

		inspect: function () {
			return access.inspectWarrant();
		},

		select: function (name) {
			return access.selectWarrant(name);
		},

		capture: function (name, title, destination, key) {
			return access.captureWarrant(
				name,
				title,
				destination,
				key
			);
		},

		generate: function (name, input, destination, key) {
			return access.generateWarrant(
				name,
				input,
				destination,
				key
			);
		},

		apply: function (name, target, change) {
			access.editWarrant(name, target, change);
		},

		narrow: function (specification, destination, key) {
			return access.narrowWarrant(
				specification,
				destination,
				key
			);
		}
	});
};