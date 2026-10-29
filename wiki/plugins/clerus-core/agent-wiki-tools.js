/*\
title: $:/plugins/clerus/core/agent-wiki-tools.js
type: application/javascript
module-type: library
\*/

"use strict";

function record(value) {
	return value &&
		typeof value === "object" &&
		!Array.isArray(value);
}

function exactKeys(value, expected) {
	return record(value) &&
		Object.keys(value).length === expected.length &&
		expected.every(function (key) {
			return Object.prototype.hasOwnProperty.call(value, key);
		});
}

function result(id, payload) {
	return {
		id: id,
		content: JSON.stringify(payload)
	};
}

function refused(id, code) {
	return result(id, {
		ok: false,
		error: code
	});
}

exports.definitions = [
	{
		type: "function",
		function: {
			name: "read_document",
			description: "Read the document assigned to this task.",
			parameters: {
				type: "object",
				properties: {},
				additionalProperties: false
			}
		}
	},
	{
		type: "function",
		function: {
			name: "replace_document_text",
			description:
				"Replace the assigned document text, but only if its " +
				"current text exactly matches expected_text.",
			parameters: {
				type: "object",
				properties: {
					expected_text: { type: "string" },
					text: { type: "string" }
				},
				required: ["expected_text", "text"],
				additionalProperties: false
			}
		}
	}
];

exports.execute = function (calls, operational, binding) {
	if (
		!record(binding) ||
		typeof binding.documentKey !== "string" ||
		!binding.documentKey ||
		typeof binding.warrantKey !== "string" ||
		!binding.warrantKey
	) {
		throw new Error("Invalid agent wiki-tool binding");
	}

	if (!Array.isArray(calls) || calls.length === 0 || calls.length > 8) {
		throw new Error("Invalid agent tool batch size");
	}

	var ids = new Set();

	// Validate the entire envelope before performing any operation.
	calls.forEach(function (call) {
		if (
			!record(call) ||
			typeof call.id !== "string" ||
			!call.id ||
			ids.has(call.id) ||
			call.type !== "function" ||
			!record(call.function) ||
			typeof call.function.name !== "string" ||
			typeof call.function.arguments !== "string"
		) {
			throw new Error("Invalid agent tool-call envelope");
		}

		ids.add(call.id);
	});

	return calls.map(function (call) {
		var name = call.function.name;

		if (
			name !== "read_document" &&
			name !== "replace_document_text"
		) {
			return refused(call.id, "unknown-tool");
		}

		var args;

		try {
			args = JSON.parse(call.function.arguments);
		} catch (error) {
			return refused(call.id, "invalid-json");
		}

		if (
			name === "read_document"
				? !exactKeys(args, [])
				: (
					!exactKeys(args, ["expected_text", "text"]) ||
					typeof args.expected_text !== "string" ||
					typeof args.text !== "string"
				)
		) {
			return refused(call.id, "invalid-arguments");
		}

		var document;
		var text;

		try {
			document = operational.get(binding.documentKey);
			text = document.text();
		} catch (error) {
			return refused(call.id, "document-unavailable");
		}

		if (name === "read_document") {
			return result(call.id, {
				ok: true,
				text: text
			});
		}

		if (text !== args.expected_text) {
			return refused(call.id, "text-conflict");
		}

		try {
			document.patch(binding.warrantKey, {
				set: { text: args.text }
			});
		} catch (error) {
			// Do not disclose internal titles, keys or arbitrary exception
			// messages to the model.
			return refused(call.id, "write-refused");
		}

		return result(call.id, {
			ok: true,
			text: args.text
		});
	});
};