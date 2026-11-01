/*\
title: $:/plugins/clerus/core2/documents/tiddler-title.js
type: application/javascript
module-type: library
\*/

"use strict";

var hasOwn = Function.call.bind(
	Object.prototype.hasOwnProperty
);

function requireExisting(view) {
	if (view.kind === "absent") {
		throw new Error("Tiddler does not exist");
	}

	return view.fields;
}

exports.create = function (access) {
	return Object.freeze({
		inspect: function () {
			return access.inspectTiddler();
		},

		field: function (name) {
			// Also checks access lifetime before validating arguments.
			var view = access.inspectTiddler();

			if (typeof name !== "string") {
				throw new Error("Field name must be a string");
			}

			var fields = requireExisting(view);

			return hasOwn(fields, name)
				? fields[name]
				: undefined;
		},

		text: function () {
			var fields = requireExisting(
				access.inspectTiddler()
			);

			return hasOwn(fields, "text")
				? fields.text
				: "";
		}
	});
};