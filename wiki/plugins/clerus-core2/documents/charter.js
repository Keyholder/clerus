/*\
title: $:/plugins/clerus/core/documents/charter.js
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
		},

		setStatus: function (value) {
			access.setStatus(value);
		},

		createMemo: function (data, destination, key) {
			return access.createMemo(data, destination, key);
		},

		createTitle: function (segment, destination, key, temporary) {
			return access.createJobTitle(
				segment,
				destination,
				key,
				temporary
			);
		},

		defer: function () {
			access.defer();
		},
	});
};