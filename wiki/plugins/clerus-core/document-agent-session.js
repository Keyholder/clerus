/*\
title: $:/plugins/clerus/core/document-agent-session.js
type: application/javascript
module-type: clerus-document
\*/

"use strict";

var copyJSON = require("$:/plugins/clerus/core/json.js").copy;
var agentCalls =
	require("$:/plugins/clerus/core/document-agent-call.js");
var agentMessages =
	require("$:/plugins/clerus/core/agent-messages.js");

function isRecord(value) {
	return value &&
		typeof value === "object" &&
		!Array.isArray(value);
}

function validate(document) {
	if (
		!isRecord(document) ||
		document.form !== "agent-session" ||
		typeof document.id !== "string" ||
		!/^[A-Za-z0-9_-]+$/.test(document.id) ||
		!isRecord(document.call) ||
		typeof document.call.key !== "string" ||
		!document.call.key ||
		typeof document.call.id !== "string" ||
		!/^[A-Za-z0-9_-]+$/.test(document.call.id) ||
		!isRecord(document.parameters) ||
		typeof document.parameters.model !== "string" ||
		!document.parameters.model.trim() ||
		Object.prototype.hasOwnProperty.call(
			document.parameters, "messages"
		) ||
		!Array.isArray(document.messages) ||
		["ready", "waiting", "tools", "failed", "uncertain"]
			.indexOf(document.phase) === -1
	) {
		throw new Error("Invalid agent-session document");
	}

	var pendingTools = agentMessages.validate(document.messages);

	if (
		(document.phase === "tools" && pendingTools.length === 0) ||
		(document.phase !== "tools" && pendingTools.length > 0)
	) {
		throw new Error("Session phase does not match pending tool calls");
	}

	if (
		document.phase === "waiting" &&
		(
			!isRecord(document.pending) ||
			typeof document.pending.operation !== "string" ||
			!isRecord(document.pending.request) ||
			document.messages.length === 0 ||
			["user", "tool"].indexOf(
				document.messages[document.messages.length - 1].role
			) === -1
		)
	) {
		throw new Error("Invalid pending agent-session operation");
	}

	if (
		(document.phase === "failed" || document.phase === "uncertain") &&
		(
			!isRecord(document.error) ||
			typeof document.error.message !== "string"
		)
	) {
		throw new Error("Settled agent session must contain an error");
	}
}

function linkedCall(session, call) {
	agentCalls.validate(call);

	if (call.id !== session.call.id) {
		throw new Error("Linked agent-call identity has changed");
	}
}

function requestFor(session) {
	var request = copyJSON(session.parameters);

	request.messages = copyJSON(session.messages);

	return request;
}

exports.validate = validate;

exports.forms = {
	"agent-session": function (access) {
		function read() {
			var document = access.read();

			validate(document);

			if (document.call.key === access.key) {
				throw new Error("Session cannot reference itself");
			}

			return document;
		}

		function update(action) {
			var session = read();

			access.updateDocuments(
				[access.key, session.call.key],
				function (documents) {
					var current = documents[access.key];
					var call = documents[session.call.key];

					validate(current);
					linkedCall(current, call);

					action(current, call, documents);

					return documents;
				}
			);
		}

		return Object.freeze({
			inspect: read,

			send: function (text) {
				if (typeof text !== "string" || !text.trim()) {
					throw new Error("Session input must be non-empty text");
				}

				update(function (session, call, documents) {
					if (session.phase !== "ready") {
						throw new Error("Agent session is not ready");
					}

					session.messages.push({
						role: "user",
						content: text
					});

					var request = requestFor(session);
					var queued = agentCalls.submission(call, request);

					session.phase = "waiting";
					session.pending = {
						operation: queued.operation,
						request: copyJSON(request)
					};

					delete session.error;

					documents[session.call.key] = queued;
				});
			},

			receive: function () {
				var before = read();

				// An already accepted response must not append another turn.
				if (before.phase !== "waiting") {
					return false;
				}

				var accepted = false;

				update(function (session, call) {
					if (
						call.operation !== session.pending.operation ||
						JSON.stringify(call.request) !==
							JSON.stringify(session.pending.request) ||
						JSON.stringify(requestFor(session)) !==
							JSON.stringify(session.pending.request)
					) {
						throw new Error(
							"Linked agent-call operation has changed"
						);
					}

					if (
						call.phase === "queued" ||
						call.phase === "running"
					) {
						return;
					}

					if (call.phase === "completed") {
						var message =
							agentMessages.responseMessage(call.response);

						session.messages.push(message);
						session.phase = message.tool_calls
							? "tools"
							: "ready";

						delete session.error;
					} else if (
						call.phase === "failed" ||
						call.phase === "uncertain"
					) {
						session.phase = call.phase;
						session.error = copyJSON(call.error);
					} else {
						throw new Error(
							"Linked agent-call has no pending result"
						);
					}

					session.lastOperation = session.pending.operation;
					delete session.pending;
					accepted = true;
				});

				return accepted;
			},

			resolveTools: function (results) {
				var values = copyJSON(results);

				if (
					!Array.isArray(values) ||
					values.length === 0
				) {
					throw new Error("Tool results must be a non-empty array");
				}

				update(function (session, call, documents) {
					if (session.phase !== "tools") {
						throw new Error("Agent session is not awaiting tools");
					}

					// Prevent a separately reused call document from being
					// silently adopted by this session.
					if (
						call.phase !== "completed" ||
						call.operation !== session.lastOperation
					) {
						throw new Error(
							"Linked agent-call operation has changed"
						);
					}

					var message =
						session.messages[session.messages.length - 1];

					var accepted =
						agentMessages.responseMessage(call.response);

					if (
						JSON.stringify(message) !==
						JSON.stringify(accepted)
					) {
						throw new Error(
							"Accepted tool calls no longer match the response"
						);
					}

					var calls = message.tool_calls;
					var byId = new Map();

					values.forEach(function (result) {
						if (
							!isRecord(result) ||
							typeof result.id !== "string" ||
							typeof result.content !== "string" ||
							byId.has(result.id)
						) {
							throw new Error("Invalid or duplicate tool result");
						}

						byId.set(result.id, result.content);
					});

					if (
						byId.size !== calls.length ||
						!calls.every(function (invocation) {
							return byId.has(invocation.id);
						})
					) {
						throw new Error(
							"Tool results must exactly cover pending calls"
						);
					}

					calls.forEach(function (invocation) {
						session.messages.push({
							role: "tool",
							tool_call_id: invocation.id,
							content: byId.get(invocation.id)
						});
					});

					var request = requestFor(session);
					var queued = agentCalls.submission(call, request);

					session.phase = "waiting";
					session.pending = {
						operation: queued.operation,
						request: copyJSON(request)
					};

					delete session.error;

					documents[session.call.key] = queued;
				});
			}
		});
	}
};

exports.rules = {
	"agent-session": {
		transfer: "never",
		receipt: "automatic",
		messages: []
	}
};