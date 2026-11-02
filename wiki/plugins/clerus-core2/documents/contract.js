/*\
title: $:/plugins/clerus/core/documents/contract.js
type: application/javascript
module-type: library
\*/

"use strict";

exports.create = function (access) {
	return Object.freeze({
		executor: function () {
			return access.read().executor;
		},

		book: function () {
			return access.read().book;
		},

		temp: function () {
			return access.read().temp;
		},

		accept: function (key, status) {
			return access.acceptContract(key, status);
		}
	});
};