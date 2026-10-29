/*\
title: $:/plugins/clerus/core/browser-credentials.js
type: application/javascript
module-type: library
\*/

"use strict";

var KEY = "clerus.openrouter.api-key.v1";

function createStore(host) {
	function storage(persistent) {
		return persistent ? host.localStorage : host.sessionStorage;
	}

	function normalize(value) {
		if (
			typeof value !== "string" ||
			!value.trim() ||
			/[\r\n]/.test(value)
		) {
			throw new Error("A non-empty OpenRouter API key is required");
		}

		return value.trim();
	}

	function unavailable() {
		return new Error("Browser credential storage is unavailable");
	}

	return Object.freeze({
		getApiKey: function () {
			try {
				var session = storage(false).getItem(KEY);

				if (session !== null) {
					return normalize(session);
				}

				var persistent = storage(true).getItem(KEY);

				return persistent === null
					? undefined
					: normalize(persistent);
			} catch (error) {
				// Never propagate arbitrary storage errors or stored values.
				throw unavailable();
			}
		},

		setApiKey: function (value, persistent) {
			value = normalize(value);
			persistent = persistent === true;

			try {
				/*
				Remove both previous copies first. Failure is reported;
				success must not leave an older key in another store.

				Web storage has no transaction across these operations.
				On failure the user may need to enter the key again.
				*/
				storage(false).removeItem(KEY);
				storage(true).removeItem(KEY);
				storage(persistent).setItem(KEY, value);
			} catch (error) {
				throw unavailable();
			}
		},

		clear: function () {
			var failed = false;

			[false, true].forEach(function (persistent) {
				try {
					storage(persistent).removeItem(KEY);
				} catch (error) {
					failed = true;
				}
			});

			if (failed) {
				throw unavailable();
			}
		}
	});
}

exports.createStore = createStore;