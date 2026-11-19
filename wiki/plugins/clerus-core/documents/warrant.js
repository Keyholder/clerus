/*\
title: $:/plugins/clerus/core/documents/warrant.js
type: application/javascript
module-type: library
\*/

"use strict";

exports.create = function (access) {
	return Object.freeze({
		/*
		Returns an isolated declaration, not an authorization verdict.
		*/
		declaration: function () {
			return access.read();
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