/*\
title: $:/plugins/clerus/core/deferred-effect.js
type: application/javascript
module-type: library
\*/

"use strict";

function validate(effect) {
	var recipient = effect && effect.recipient;

	if (
		!effect ||
		effect.version !== 1 ||
		effect.kind !== "deferred-event" ||
		typeof effect.id !== "string" ||
		!/^[A-Za-z0-9_-]+$/.test(effect.id) ||
		!recipient ||
		typeof recipient.title !== "string" ||
		recipient.title.indexOf("$:/clerus/jobs/") !== 0 ||
		typeof recipient.executor !== "string" ||
		!recipient.executor ||
		(
			recipient.platform !== "browser" &&
			recipient.platform !== "node"
		)
	) {
		throw new Error("Invalid deferred event effect");
	}
}

function create(options) {
	var effect = {
		version: 1,
		kind: "deferred-event",
		id: options.id,
		recipient: {
			title: options.recipient.title,
			executor: options.recipient.executor,
			platform: options.recipient.platform
		}
	};

	validate(effect);

	Object.freeze(effect.recipient);

	return Object.freeze(effect);
}

exports.validate = validate;
exports.create = create;