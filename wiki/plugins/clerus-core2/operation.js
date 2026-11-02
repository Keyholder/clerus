/*\
title: $:/plugins/clerus/core2/operation.js
type: application/javascript
module-type: library
\*/

"use strict";

function MaterializationError(cause) {
	this.name = "MaterializationError";
	this.message = String(cause && cause.message || cause);
	this.cause = cause;

	var diagnostic = new Error(this.message);

	this.stack = diagnostic.stack;
}

MaterializationError.prototype = Object.create(Error.prototype);
MaterializationError.prototype.constructor = MaterializationError;

exports.run = function (options, prepare) {
	options.assertActive();

	var candidate = options.fork();
	var result = prepare(candidate);

	options.validate(candidate);
	options.assertActive();

	try {
		options.materialize(candidate);
	} catch (error) {
		if (options.atomicMaterialization === true) {
			throw error;
		}

		options.invalidate();

		if (error instanceof MaterializationError) {
			throw error;
		}

		throw new MaterializationError(error);
	}

	options.publish(candidate);

	return result;
};

exports.MaterializationError = MaterializationError;