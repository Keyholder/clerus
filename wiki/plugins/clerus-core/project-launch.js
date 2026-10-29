/*\
title: $:/plugins/clerus/core/project-launch.js
type: application/javascript
module-type: library
\*/

"use strict";

var sourceBundles =
	require("$:/plugins/clerus/core/source-bundle.js");

exports.launch = function (tw, options) {
	options = options || {};

	if (
		!tw.browser ||
		!tw.clerus ||
		!tw.clerus.dispatcher ||
		!tw.clerus.dispatcher.started
	) {
		throw new Error("Browser Clerus runtime is unavailable");
	}

	var agent = options.mode === "answer";

	if (
		options.mode !== undefined &&
		options.mode !== "probe" &&
		options.mode !== "answer"
	) {
		throw new Error("Unsupported project mode");
	}

	if (
		agent &&
		(
			typeof options.model !== "string" ||
			!options.model.trim()
		)
	) {
		throw new Error("Model is required");
	}

	if (
		agent &&
		!tw.clerus.dispatcher.agentCalls
	) {
		throw new Error("Browser agent transport is unavailable");
	}

	var executor = agent
		? "clerus-project-answer"
		: "clerus-project-probe";
	var module = tw.clerus.dispatcher.executors.get(executor);

	if (!module || typeof module.browser !== "function") {
		throw new Error("Project probe executor is unavailable");
	}

	if (
		typeof options.prompt !== "string" ||
		!options.prompt.trim()
	) {
		throw new Error("Task text is required");
	}

	var sourceTitle = "";
	var sourceEntries = [];

	if (
		agent &&
		options.sourceTitle !== undefined &&
		options.sourceTitle !== ""
	) {
		sourceTitle = options.sourceTitle;
		sourceEntries = sourceBundles.resolve(tw.wiki, sourceTitle);
	}

	var id = Date.now().toString(36) + "-" +
		Math.random().toString(36).slice(2);

	var project = "Clerus Projects/" + id;
	var job = "$:/clerus/jobs/projects/" + id;

	[project, job].concat(
		agent ? [project + "/Result"] : []
	).forEach(function (title) {
		if (
			tw.wiki.getTiddler(title) ||
			tw.wiki.isShadowTiddler(title)
		) {
			throw new Error("Launch title already exists");
		}
	});

	var registry = {
		charter: {
			form: "charter",
			status: { phase: "prepared" }
		},
		mission: {
			form: "mission",
			project: project,
			role: [],
			link: "1",
			issued: "0",
			children: {}
		},
		work: {
			form: "memo",
			data: { phase: "idle" }
		}
	};

	var maxTokens = 2048;

	if (
		agent &&
		options.maxTokens !== undefined &&
		options.maxTokens !== ""
	) {
		var rawMaxTokens = options.maxTokens;

		if (typeof rawMaxTokens === "string") {
			rawMaxTokens = rawMaxTokens.trim();

			if (!/^[1-9][0-9]*$/.test(rawMaxTokens)) {
				throw new Error(
					"Лимит ответа должен быть положительным целым числом."
				);
			}

			rawMaxTokens = Number(rawMaxTokens);
		}

		if (
			!Number.isSafeInteger(rawMaxTokens) ||
			rawMaxTokens <= 0
		) {
			throw new Error(
				"Лимит ответа должен быть положительным целым числом."
			);
		}

		maxTokens = rawMaxTokens;
	}

	if (agent) {
		registry.session = {
			form: "agent-session",
			id: "session-" + id,
			call: {
				key: "call",
				id: "call-" + id
			},
			parameters: {
				model: options.model.trim(),
				max_tokens: maxTokens
			},
			messages: [],
			phase: "ready"
		};

		registry.call = {
			form: "agent-call",
			id: "call-" + id,
			sequence: "0",
			phase: "idle"
		};

		var resultTitle = project + "/Result";

		registry.charter.book = {
			resultTitle: resultTitle
		};

		if (sourceTitle) {
			registry.charter.book.sources = sourceEntries.map(function (entry, index) {
				// Preserve the existing key for the single-source case.
				var key = sourceEntries.length === 1
					? "source"
					: "source" + index;

				registry[key] = entry.title;

				return {
					key: key,
					title: entry.title,
					label: entry.label
				};
			});
		}

		registry.publication = {
			form: "warrant",
			filter: "[title[" + resultTitle + "]]",
			operations: ["create"],
			fields: [],
			mission: {
				project: project,
				role: [],
				link: "1"
			},
			templates: {
				answer: {
					title: resultTitle,
					parameters: {
						body: "string"
					},
					fields: {
						type: "text/plain",
						text: "{{body}}",
						"clerus-source-project": project,
						"clerus-source-job": job
					}
				}
			}
		};

		if (sourceTitle) {
			registry.publication.templates.answer.fields[
				"clerus-source-tiddler"
			] = sourceTitle;
		}
	}

	/*
	Prepare everything under user custody.
	The final job custody write makes the executor runnable.

	This is not an atomic multi-tiddler transaction. Interrupted
	preparation may leave user-owned artifacts for inspection.
	*/
	tw.wiki.addTiddler(new tw.Tiddler({
		title: project,
		type: "application/json",
		"clerus-custody": "user",
		"clerus-root-job": job,
		"clerus-project-mode": agent ? "answer" : "probe",
		text: JSON.stringify({
			task: {
				prompt: options.prompt.trim()
			},
			parts: {}
		})
	}));

	tw.wiki.addTiddler(new tw.Tiddler({
		title: job,
		type: "application/json",
		"clerus-custody": "user",
		"clerus-executor": executor,
		text: JSON.stringify(registry)
	}));

	tw.wiki.addTiddler(new tw.Tiddler(
		tw.wiki.getTiddler(job),
		{ "clerus-custody": "browser" }
	));

	return {
		project: project,
		job: job
	};
};