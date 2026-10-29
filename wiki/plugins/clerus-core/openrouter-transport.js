/*\
title: $:/plugins/clerus/core/openrouter-transport.js
type: application/javascript
module-type: library
\*/

"use strict";

var copyJSON = require("$:/plugins/clerus/core/json.js").copy;
var agentMessages =
	require("$:/plugins/clerus/core/agent-messages.js");

var ENDPOINT = "https://openrouter.ai/api/v1/chat/completions";

var PARAMETERS = [
	"model",
	"messages",
	"temperature",
	"top_p",
	"max_tokens",
	"stop",
	"seed",
	"tools"
];

function failure(name, message, definitelyNotExecuted) {
	var error = new Error(message);

	error.name = name;

	if (definitelyNotExecuted) {
		error.definitelyNotExecuted = true;
	}

	return error;
}

function invalid(message) {
	return failure("OpenRouterRequestError", message, true);
}

function prepare(request) {
	var body;

	try {
		body = copyJSON(request);
	} catch (error) {
		throw invalid("OpenRouter request must be JSON");
	}

	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw invalid("OpenRouter request must be an object");
	}

	Object.keys(body).forEach(function (key) {
		if (PARAMETERS.indexOf(key) === -1) {
			throw invalid("Unsupported OpenRouter request parameter");
		}
	});

	if (typeof body.model !== "string" || !body.model.trim()) {
		throw invalid("OpenRouter request must name a model");
	}

	if (!Array.isArray(body.messages) || body.messages.length === 0) {
		throw invalid("OpenRouter request must contain messages");
	}

	try {
		var pending = agentMessages.validate(body.messages);

		if (pending.length > 0) {
			throw new Error("Tool results are missing");
		}
	} catch (error) {
		throw invalid("Invalid OpenRouter conversation history");
	}

	if (body.tools !== undefined) {
		if (
			!Array.isArray(body.tools) ||
			body.tools.length === 0
		) {
			throw invalid("OpenRouter tools must be a non-empty array");
		}

		var names = new Set();

		body.tools.forEach(function (tool) {
			if (
				!tool ||
				tool.type !== "function" ||
				!tool.function ||
				typeof tool.function.name !== "string" ||
				!/^[A-Za-z0-9_-]{1,64}$/.test(tool.function.name) ||
				names.has(tool.function.name) ||
				!tool.function.parameters ||
				typeof tool.function.parameters !== "object" ||
				Array.isArray(tool.function.parameters)
			) {
				throw invalid("Invalid OpenRouter tool declaration");
			}

			names.add(tool.function.name);
		});
	}

	["temperature", "top_p"].forEach(function (key) {
		if (
			body[key] !== undefined &&
			(typeof body[key] !== "number" || !Number.isFinite(body[key]))
		) {
			throw invalid("Invalid OpenRouter sampling parameter");
		}
	});

	if (
		body.max_tokens !== undefined &&
		(!Number.isSafeInteger(body.max_tokens) || body.max_tokens <= 0)
	) {
		throw invalid("OpenRouter max_tokens must be a positive integer");
	}

	if (
		body.seed !== undefined &&
		!Number.isSafeInteger(body.seed)
	) {
		throw invalid("OpenRouter seed must be a safe integer");
	}

	if (
		body.stop !== undefined &&
		typeof body.stop !== "string" &&
		!(
			Array.isArray(body.stop) &&
			body.stop.every(function (item) {
				return typeof item === "string";
			})
		)
	) {
		throw invalid("Invalid OpenRouter stop parameter");
	}

	body.stream = false;

	return body;
}

function validateResponse(response) {
	function unsupported(message) {
		throw failure("OpenRouterResponseError", message);
	}

	if (
		!response ||
		typeof response !== "object" ||
		Array.isArray(response)
	) {
		unsupported("OpenRouter returned an invalid completion envelope");
	}

	if (response.error) {
		unsupported(
			"OpenRouter returned an error inside the completion response; " +
			"provider details were not persisted"
		);
	}

	var choice = Array.isArray(response.choices) &&
		response.choices[0];

	if (!choice) {
		unsupported("OpenRouter completion contains no response choice");
	}

	try {
		agentMessages.responseMessage(response);
	} catch (error) {
		if (choice.finish_reason === "length") {
			unsupported(
				"OpenRouter stopped generation at the output limit, " +
				"but returned no supported assistant message"
			);
		}

		unsupported(
			"OpenRouter returned a response choice " +
			"without a supported assistant message"
		);
	}
}

function createTransport(options) {
	options = options || {};

	if (typeof options.fetch !== "function") {
		throw new Error("OpenRouter transport requires fetch");
	}

	if (typeof options.getApiKey !== "function") {
		throw new Error("OpenRouter transport requires an API key provider");
	}

	var fetchRequest = options.fetch;
	var getApiKey = options.getApiKey;
	var AbortControllerClass = options.AbortController;
	var timeoutMs = options.timeoutMs === undefined
		? 120000
		: options.timeoutMs;

	if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
		throw new Error("OpenRouter timeout must be a positive integer");
	}

	if (typeof AbortControllerClass !== "function") {
		throw new Error("OpenRouter transport requires AbortController");
	}

	return async function (request) {
		var body = prepare(request);
		var apiKey;

		try {
			apiKey = getApiKey();
		} catch (error) {
			throw failure(
				"OpenRouterConfigurationError",
				"OpenRouter API key is unavailable",
				true
			);
		}

		if (
			typeof apiKey !== "string" ||
			!apiKey.trim() ||
			/[\r\n]/.test(apiKey)
		) {
			throw failure(
				"OpenRouterConfigurationError",
				"OpenRouter API key is unavailable",
				true
			);
		}

		var controller = new AbortControllerClass();
		var timedOut = false;
		var timer = setTimeout(function () {
			timedOut = true;
			controller.abort();
		}, timeoutMs);

		try {
			var response;

			try {
				response = await fetchRequest(ENDPOINT, {
					method: "POST",
					redirect: "error",
					headers: {
						"Authorization": "Bearer " + apiKey.trim(),
						"Content-Type": "application/json",
						"Accept": "application/json"
					},
					body: JSON.stringify(body),
					signal: controller.signal
				});
			} catch (error) {
				// Do not preserve arbitrary fetch errors: they may contain
				// request details or credentials.
				throw failure(
					timedOut
						? "OpenRouterTimeoutError"
						: "OpenRouterNetworkError",
					timedOut
						? "OpenRouter request timed out; outcome is unknown"
						: "OpenRouter request failed; outcome is unknown"
				);
			}

			if (!response.ok) {
				// Conservatively do not claim that inference never ran.
				// Provider error messages are intentionally not persisted.
				throw failure(
					"OpenRouterHTTPError",
					"OpenRouter returned HTTP " + response.status
				);
			}

			var responseText;
			var readStarted = Date.now();

			function responseFailure(name, message, details) {
				/*
				Only locally constructed diagnostic fields are persisted.
				No provider text, arbitrary exception message or headers.
				*/
				return failure(
					name,
					message + "; diagnostics=" + JSON.stringify(details)
				);
			}

			function mediaType() {
				var value = response.headers &&
					typeof response.headers.get === "function"
					? response.headers.get("content-type")
					: "";

				value = String(value || "").split(";")[0].trim().toLowerCase();

				if (
					value === "application/json" ||
					value === "text/event-stream" ||
					value === "text/html" ||
					value === "text/plain"
				) {
					return value;
				}

				return value ? "other" : "missing";
			}

			try {
				responseText = await response.text();
			} catch (error) {
				throw responseFailure(
					timedOut
						? "OpenRouterTimeoutError"
						: "OpenRouterBodyReadError",
					timedOut
						? "OpenRouter response body reading timed out; outcome is unknown"
						: "OpenRouter response body could not be fully read; outcome is unknown",
					{
						stage: "body-read",
						status: response.status,
						mediaType: mediaType(),
						readElapsedMs: Date.now() - readStarted,
						timeoutMs: timeoutMs
					}
				);
			}

			var result;

			try {
				result = JSON.parse(responseText);
			} catch (error) {
				var trimmed = responseText.trim();
				var format = "invalid-json";

				if (!trimmed) {
					format = "empty";
				} else if (/^(?:data:|event:|:)/.test(trimmed)) {
					format = "event-stream-like";
				} else if (/^(?:<!doctype\s+html|<html\b)/i.test(trimmed)) {
					format = "html-like";
				}

				throw responseFailure(
					"OpenRouterJSONParseError",
					"OpenRouter response body was read, but is not valid JSON; " +
						"outcome is unknown",
					{
						stage: "json-parse",
						status: response.status,
						mediaType: mediaType(),
						bodyCharacters: responseText.length,
						format: format,
						readElapsedMs: Date.now() - readStarted,
						timeoutMs: timeoutMs
					}
				);
			}

			validateResponse(result);

			// Preserve usage, provider/model metadata and response identity.
			return copyJSON(result);
		} finally {
			clearTimeout(timer);
		}
	};
}

exports.createTransport = createTransport;