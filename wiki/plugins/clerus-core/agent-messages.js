/*\
title: $:/plugins/clerus/core/agent-messages.js
type: application/javascript
module-type: library
\*/

"use strict";

var copyJSON = require("$:/plugins/clerus/core/json.js").copy;

function record(value) {
	return value &&
		typeof value === "object" &&
		!Array.isArray(value);
}

function toolCalls(calls) {
	if (!Array.isArray(calls) || calls.length === 0) {
		throw new Error("Tool calls must be a non-empty array");
	}

	var ids = new Set();

	calls.forEach(function (call) {
		if (
			!record(call) ||
			typeof call.id !== "string" ||
			!call.id ||
			ids.has(call.id) ||
			call.type !== "function" ||
			!record(call.function) ||
			typeof call.function.name !== "string" ||
			!call.function.name ||
			typeof call.function.arguments !== "string"
		) {
			throw new Error("Invalid or duplicate tool call");
		}

		ids.add(call.id);
	});
}

function assistant(message) {
	if (
		!record(message) ||
		message.role !== "assistant" ||
		(
			typeof message.content !== "string" &&
			message.content !== null
		)
	) {
		throw new Error("Invalid assistant message");
	}

	var result = {
		role: "assistant",
		content: message.content
	};

	if (
		message.tool_calls !== undefined &&
		!(
			Array.isArray(message.tool_calls) &&
			message.tool_calls.length === 0
		)
	) {
		toolCalls(message.tool_calls);

		result.tool_calls = message.tool_calls.map(function (call) {
			return {
				id: call.id,
				type: "function",
				function: {
					name: call.function.name,
					arguments: call.function.arguments
				}
			};
		});
	} else if (typeof message.content !== "string") {
		throw new Error("Assistant response contains neither text nor tools");
	}

	return result;
}

// A valid history may end with unanswered tool calls, but never with
// partially answered calls. Results are always stored as one batch.
function validate(messages) {
	if (!Array.isArray(messages)) {
		throw new Error("Messages must be an array");
	}

	var pending = [];

	messages.forEach(function (message) {
		if (!record(message)) {
			throw new Error("Invalid conversation message");
		}

		if (pending.length > 0) {
			if (
				message.role !== "tool" ||
				message.tool_call_id !== pending[0] ||
				typeof message.content !== "string"
			) {
				throw new Error("Tool results must follow their calls in order");
			}

			pending.shift();
			return;
		}

		if (message.role === "assistant") {
			var normalized = assistant(message);

			if (normalized.tool_calls) {
				pending = normalized.tool_calls.map(function (call) {
					return call.id;
				});
			}

			return;
		}

		if (
			["system", "user"].indexOf(message.role) === -1 ||
			typeof message.content !== "string"
		) {
			throw new Error("Invalid conversation message");
		}
	});

	return pending;
}

function responseMessage(response) {
	var choice = response &&
		Array.isArray(response.choices) &&
		response.choices[0];

	if (!choice) {
		throw new Error("Completion response contains no choice");
	}

	var message = choice.message;

	/*
	A generation may exhaust its budget before producing visible text.
	Normalize only this specific case, without changing the raw response.
	An empty string is valid conversation content, not a successful answer.
	*/
	if (
		choice.finish_reason === "length" &&
		record(message) &&
		message.role === "assistant" &&
		message.content === null &&
		(
			message.tool_calls === undefined ||
			(
				Array.isArray(message.tool_calls) &&
				message.tool_calls.length === 0
			)
		)
	) {
		return {
			role: "assistant",
			content: ""
		};
	}

	return assistant(message);
}

exports.validate = validate;
exports.assistant = assistant;
exports.responseMessage = responseMessage;
exports.copy = function (messages) {
	validate(messages);
	return copyJSON(messages);
};