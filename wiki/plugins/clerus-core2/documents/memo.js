/*\
title: $:/plugins/clerus/core2/documents/memo.js
type: application/javascript
module-type: library
\*/

"use strict";

exports.create = function (access) {
	return Object.freeze({
		data: function () {
			return access.read().data;
		},

		setData: function (value) {
			access.setData(value);
		}
	});
};