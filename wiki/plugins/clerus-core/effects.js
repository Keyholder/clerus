/*\
title: $:/plugins/clerus/core/effects.js
type: application/javascript
module-type: library
\*/

"use strict";

function normalize(fields) {
	if (
		fields === null ||
		typeof fields !== "object" ||
		Array.isArray(fields)
	) {
		throw new Error("Effect fields must be an object");
	}

	var result = Object.create(null);

	Object.keys(fields).sort().forEach(function (name) {
		if (typeof fields[name] !== "string") {
			throw new Error("Effect field values must be strings");
		}

		result[name] = fields[name];
	});

	return result;
}

function capture(tiddler) {
	if (!tiddler) {
		return null;
	}

	var fields = Object.create(null);

	Object.keys(tiddler.fields).sort().forEach(function (name) {
		fields[name] = tiddler.getFieldString(name);
	});

	return normalize(fields);
}

function equal(left, right) {
	return JSON.stringify(left) === JSON.stringify(right);
}

function seal(effect) {
	if (effect.before) {
		Object.freeze(effect.before);
	}

	if (effect.after) {
		Object.freeze(effect.after);
	}

	return Object.freeze(effect);
}

function put(before, after) {
	var next = capture(after);
	var previous = capture(before);

	if (!next || typeof next.title !== "string") {
		throw new Error("Put effect requires a titled tiddler");
	}

	if (previous && previous.title !== next.title) {
		throw new Error("Put effect cannot rename a tiddler");
	}

	return seal({
		version: 1,
		kind: "tiddler-put",
		title: next.title,
		before: previous,
		after: next
	});
}

function remove(before) {
	var previous = capture(before);

	if (!previous || typeof previous.title !== "string") {
		throw new Error("Delete effect requires an existing tiddler");
	}

	return seal({
		version: 1,
		kind: "tiddler-delete",
		title: previous.title,
		before: previous,
		after: null
	});
}

function validate(effect) {
	if (
		!effect ||
		effect.version !== 1 ||
		typeof effect.title !== "string" ||
		effect.title.length === 0 ||
		(
			effect.kind !== "tiddler-put" &&
			effect.kind !== "tiddler-delete"
		)
	) {
		throw new Error("Invalid effect envelope");
	}

	var before = effect.before === null ? null : normalize(effect.before);
	var after = effect.after === null ? null : normalize(effect.after);

	if (
		(before && before.title !== effect.title) ||
		(after && after.title !== effect.title) ||
		(effect.kind === "tiddler-put" && !after) ||
		(effect.kind === "tiddler-delete" && (!before || after))
	) {
		throw new Error("Invalid effect state");
	}

	return {
		before: before,
		after: after
	};
}

function check(wiki, effect) {
	var states = validate(effect);

	var current = wiki.tiddlerExists(effect.title)
		? capture(wiki.getTiddler(effect.title))
		: null;

	if (equal(current, states.after)) {
		return "already-applied";
	}

	if (!equal(current, states.before)) {
		throw new Error("Effect precondition failed: " + effect.title);
	}

	return "ready";
}

function apply(wiki, Tiddler, effect) {
	if (check(wiki, effect) === "already-applied") {
		return "already-applied";
	}

	var states = validate(effect);

	if (effect.kind === "tiddler-put") {
		wiki.addTiddler(new Tiddler(states.after));
	} else {
		wiki.deleteTiddler(effect.title);
	}

	return "applied";
}

exports.capture = capture;
exports.put = put;
exports.remove = remove;
exports.check = check;
exports.apply = apply;