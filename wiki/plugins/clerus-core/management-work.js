/*\
title: $:/plugins/clerus/core/management-work.js
type: application/javascript
module-type: library
\*/

"use strict";

var stores = require("$:/plugins/clerus/core/store.js");
var schemas = require("$:/plugins/clerus/core/schemas.js");
var continuations = require(
	"$:/plugins/clerus/core/continuation-schema.js"
);
var compatibility = require(
	"$:/plugins/clerus/core/work-compatibility.js"
);
var materializer = require(
	"$:/plugins/clerus/core/work-materializer.js"
);

exports.create = function (options) {
	schemas.assertPlatform(options.platform);

	var store = new stores.Store({
		wiki: options.wiki,
		Tiddler: options.Tiddler
	});

	/*
	Publish a fully prepared continuation without changing its
	deadline or rewriting its work.

	This is user authoring, not runtime acceptance or execution.
	*/
	function publishRecord(value, journal) {
		var record = continuations.validate(
			value,
			options.platform,
			journal
		);

		if (record.work === null) {
			throw new Error("User work publication requires active work");
		}

		compatibility.check({
			store: store,
			work: record.work
		});

		materializer.check({
			store: store,
			platform: options.platform,
			work: record.work
		});

		store.apply(stores.transition(journal, null, {
			title: journal,
			type: "application/json",
			"clerus-custody": "user",
			"clerus-wal-kind": "continuation",
			text: JSON.stringify(record, null, 2)
		}));
	}

	/*
	Construct a new user continuation around prepared work.
	Transfers requiring a matching preselected deadline should
	use publishRecord() instead.
	*/
	function publish(work, journal) {
		var record = {
			version: 2,
			kind: "continuation",
			platform: options.platform,
			work: work,
			events: {},
			evidence: {
				identities: {},
				receipts: {}
			},
			diagnostics: []
		};

		if (options.prototypeWalReceipts) {
			record.retainUntil = options.now() + 150000;
		}

		publishRecord(record, journal);
	}

	return Object.freeze({
		publish: publish,
		publishRecord: publishRecord
	});
};