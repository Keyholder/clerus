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

		narrow: function (specification, destination, key) {
			return access.narrowWarrant(
				specification,
				destination,
				key
			);
		}
	});
};