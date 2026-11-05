/*\
title: $:/plugins/clerus/core/execution-contract.js
type: application/javascript
module-type: library
\*/

"use strict";

/*
Invoke an executor and verify successful reaction completion.

The caller owns scope disposal and all reliability transitions:
plan acceptance, materialization, rollback and failure policy.
*/
function invoke(options) {
	var handler = options.handler;
	var scope = options.scope;

	if (typeof handler !== "function") {
		throw new Error("Execution contract requires a handler");
	}

	if (
		!scope ||
		typeof scope.assertResolved !== "function" ||
		typeof scope.assertOutgoingResolved !== "function"
	) {
		throw new Error("Execution contract requires a document scope");
	}

	/*
	Call as a plain function, preserving the existing executor
	contract without introducing an adapter-owned receiver.
	*/
	var returned = handler(
		options.event,
		scope.operational,
		scope.incoming
	);

	if (
		returned !== null &&
		returned !== undefined &&
		typeof returned.then === "function"
	) {
		throw new Error("Executor reactions must be synchronous");
	}

	scope.assertResolved();

	if (options.requireSentOutgoing === true) {
		scope.assertOutgoingResolved();
	}
}

exports.invoke = invoke;