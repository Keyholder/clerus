/*\
title: $:/plugins/clerus/core2/operation.js
type: application/javascript
module-type: library
\*/

"use strict";

exports.run = function (options, prepare) {
	options.assertActive();

	var candidate = options.fork();
	var result = prepare(candidate);

	options.validate(candidate);
	options.assertActive();

	try {
		options.materialize(candidate);
	} catch (error) {
		options.invalidate();
		throw error;
	}

	options.publish(candidate);

	return result;
};