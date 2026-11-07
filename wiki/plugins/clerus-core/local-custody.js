/*\
title: $:/plugins/clerus/core/local-custody.js
type: application/javascript
module-type: library
\*/

"use strict";

var schemas = require("$:/plugins/clerus/core/schemas.js");

/*
Local execution perspective.

This service answers only whether this runtime owns the supplied
tiddler state. It does not identify or authorize another custodian.

Relocation is not supported yet. Until its protocol is implemented,
the physical custody field is the complete local ownership rule.

Accepted transition authority is deliberately outside this service.
*/
function create(options) {
	var platform = schemas.assertPlatform(options.platform);

	function owns(fields) {
		if (!schemas.isRecord(fields)) {
			throw new Error(
				"Local custody requires a tiddler field record"
			);
		}

		return fields["clerus-custody"] === platform;
	}

	return Object.freeze({
		owns: owns
	});
}

exports.create = create;