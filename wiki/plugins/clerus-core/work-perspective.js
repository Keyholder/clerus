/*\
title: $:/plugins/clerus/core/work-perspective.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");
var jobTitles = require("$:/plugins/clerus/core/job-titles.js");
var works = require("$:/plugins/clerus/core/work-schema.js");

function evaluate(value) {
	var work = works.validate(value);
	var blocks = new Set(work.blocks);
	var operational = [];

	work.transitions.forEach(function (effect) {
		if (!jobTitles.isJobTitle(effect.title)) {
			return;
		}

		blocks.add(effect.title);

		operational.push({
			title: effect.title,
			registry: schemas.registry(
				JSON.parse(effect.after.text),
				"operational"
			)
		});
	});

	operational.sort(function (left, right) {
		return left.title < right.title
			? -1
			: left.title > right.title ? 1 : 0;
	});

	return schemas.copyJSON({
		id: work.id,

		writes: work.transitions.map(function (effect) {
			return effect.title;
		}).sort(),

		reads: work.checks.map(function (check) {
			return check.title;
		}).sort(),

		blocks: Array.from(blocks).sort(),

		operational: operational
	});
}

function intersects(left, right) {
	var set = new Set(left);

	return right.some(function (value) {
		return set.has(value);
	});
}

/*
Compare accepted work descriptions, not runtime authority.

No current custody or foreign execution capability is inferred.
*/
function conflicts(left, right) {
	var a = evaluate(left);
	var b = evaluate(right);

	return (
		intersects(a.writes, b.writes) ||
		intersects(a.writes, b.reads) ||
		intersects(a.reads, b.writes) ||
		intersects(a.blocks, b.blocks)
	);
}

exports.evaluate = evaluate;
exports.conflicts = conflicts;