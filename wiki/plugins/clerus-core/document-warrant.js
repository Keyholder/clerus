/*\
title: $:/plugins/clerus/core/document-warrant.js
type: application/javascript
module-type: clerus-document
\*/

"use strict";

exports.forms = {
	warrant: function (access) {
		return Object.freeze({
			templates: function () {
				var document = access.read();

				return Object.keys(document.templates || {});
			},

			create: function (templateName, parameters, destinationKey) {
				return access.createTiddler(
					templateName,
					parameters,
					destinationKey
				);
			},

			policy: function () {
				var document = access.read();
				var policy = {
					filter: document.filter,
					operations: document.operations,
					fields: document.fields
				};

				if (
					Object.prototype.hasOwnProperty.call(
						document, "mission"
					)
				) {
					policy.mission = document.mission;
				}

				return policy;
			}
		});
	}
};

exports.rules = {
	warrant: {
		transfer: "copy",
		receipt: "automatic",
		messages: ["order", "report"]
	}
};