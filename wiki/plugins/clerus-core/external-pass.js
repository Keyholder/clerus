/*\
title: $:/plugins/clerus/core/external-pass.js
type: application/javascript
module-type: library
\*/

"use strict";

var lifecycle = require("$:/plugins/clerus/core/lifecycle.js");

function Coordinator(options) {
	if (
		typeof options.autoCollect !== "boolean" ||
		typeof options.collect !== "function"
	) {
		throw new Error(
			"External pass coordinator requires collection policy and collector"
		);
	}

	this.autoCollect = options.autoCollect;
	this.collect = options.collect;
	this.depth = 0;
	this.lastCollection = null;
}

Coordinator.prototype.run = function (
	receiver,
	implementation,
	args,
	allowCollection
) {
	if (
		typeof implementation !== "function" ||
		typeof allowCollection !== "boolean"
	) {
		throw new Error("Invalid external pass contract");
	}

	this.depth++;

	var completed = false;

	try {
		var result = implementation.apply(receiver, args);

		completed = true;
		return result;
	} finally {
		this.depth--;

		if (
			completed &&
			allowCollection &&
			this.depth === 0 &&
			this.autoCollect
		) {
			try {
				this.lastCollection = this.collect();
			} catch (error) {
				/*
				Collection diagnostics must not replace
				a successfully completed execution result.
				*/
				this.lastCollection = {
					removed: [],
					skipped: [],
					blocked: ["collection-error"],
					failures: [{
						error: lifecycle.describeError(error)
					}]
				};
			}
		}
	}
};

exports.Coordinator = Coordinator;