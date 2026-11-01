/*\
title: $:/plugins/clerus/core2/documents/charter.js
type: application/javascript
module-type: library
\*/

"use strict";

exports.create = function (access) {
	return Object.freeze({
		book: function () {
			return access.read().book;
		},

		status: function () {
			return access.read().status;
		}
	});
};