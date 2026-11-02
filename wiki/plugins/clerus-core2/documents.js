/*\
title: $:/plugins/clerus/core/documents.js
type: application/javascript
module-type: library
\*/

"use strict";

var charter = require(
	"$:/plugins/clerus/core/documents/charter.js"
);
var memo = require(
	"$:/plugins/clerus/core/documents/memo.js"
);
var tiddlerTitle = require(
	"$:/plugins/clerus/core/documents/tiddler-title.js"
);
var mission = require(
	"$:/plugins/clerus/core/documents/mission.js"
);
var jobTitle = require(
	"$:/plugins/clerus/core/documents/job-title.js"
);
var contract = require(
	"$:/plugins/clerus/core/documents/contract.js"
);

exports.create = function (form, access) {
	switch (form) {
		case "charter":
			return charter.create(access);

		case "memo":
			return memo.create(access);

		case "tiddler-title":
			return tiddlerTitle.create(access);

		case "mission":
			return mission.create(access);

		case "job-title":
			return jobTitle.create(access);

		case "contract":
			return contract.create(access);

		default:
			throw new Error("Unsupported instrument form: " + form);
	}
};