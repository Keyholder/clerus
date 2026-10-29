/*\
title: $:/plugins/clerus/demo/openrouter-tools-executor.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

exports.name = "clerus-openrouter-tools-demo";

function resultFor(call) {
	function error(message) {
		return {
			id: call.id,
			content: JSON.stringify({
				ok: false,
				error: message
			})
		};
	}

	if (call.function.name !== "add") {
		return error("Unknown tool");
	}

	var args;

	try {
		args = JSON.parse(call.function.arguments);
	} catch (exception) {
		return error("Arguments must be JSON");
	}

	if (
		!args ||
		typeof args !== "object" ||
		Array.isArray(args) ||
		Object.keys(args).length !== 2 ||
		!Object.prototype.hasOwnProperty.call(args, "a") ||
		!Object.prototype.hasOwnProperty.call(args, "b") ||
		typeof args.a !== "number" ||
		typeof args.b !== "number" ||
		!Number.isFinite(args.a) ||
		!Number.isFinite(args.b)
	) {
		return error("Expected finite numeric arguments a and b");
	}

	var sum = args.a + args.b;

	if (!Number.isFinite(sum)) {
		return error("Result is not finite");
	}

	return {
		id: call.id,
		content: JSON.stringify({
			ok: true,
			result: sum
		})
	};
}

exports.node = function (event, operational) {
	if (event.type !== "ready" && event.type !== "tick") {
		return;
	}

	var session = operational.get("session");
	var charter = operational.get("charter");
	var view = session.inspect();

	if (view.phase === "waiting") {
		session.receive();
		view = session.inspect();
	}

	if (view.phase === "failed" || view.phase === "uncertain") {
		charter.setStatus({
			phase: view.phase,
			error: view.error
		});
		return;
	}

	if (view.phase === "tools") {
		var status = charter.status();
		var rounds = status.toolRounds || 0;

		// A session can otherwise keep requesting tools indefinitely.
		if (rounds >= 4) {
			charter.setStatus({
				phase: "tool-limit",
				toolRounds: rounds
			});
			return;
		}

		var calls = view.messages[view.messages.length - 1].tool_calls;

		if (calls.length > 8) {
			charter.setStatus({
				phase: "tool-batch-limit",
				toolRounds: rounds
			});
			return;
		}

		session.resolveTools(calls.map(resultFor));

		charter.setStatus({
			phase: "waiting",
			toolRounds: rounds + 1
		});
		return;
	}

	if (view.phase !== "ready") {
		return;
	}

	if (view.messages.length === 0) {
		session.send(
			"Вызови инструмент add для чисел 19 и 23, " +
			"а затем объясни полученный результат одним предложением."
		);

		charter.setStatus({
			phase: "waiting",
			toolRounds: 0
		});
		return;
	}

	charter.setStatus({
		phase: "completed",
		toolRounds: charter.status().toolRounds || 0,
		messages: view.messages
	});
};

exports.resultFor = resultFor;