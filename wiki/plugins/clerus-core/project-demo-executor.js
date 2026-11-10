/*\
title: $:/plugins/clerus/core/project-demo-executor.js
type: application/javascript
module-type: clerus-executor
\*/

"use strict";

var SEGMENTS = ["first", "second", "third"];

function initialize(operational, incoming) {
	var contract = incoming.get("contract");
	var book = contract.book();

	if (
		!book ||
		(
			book.kind !== "project-demo-root" &&
			book.kind !== "project-demo-worker"
		)
	) {
		throw new Error("Invalid project demo instruction");
	}

	var charter = contract.accept("charter", {
		phase: book.kind === "project-demo-root"
			? "awaiting-resources"
			: "waiting",
		results: {}
	});

	incoming.move("assignment", operational, "mission");

	if (book.kind === "project-demo-worker") {
		charter.defer();
	}
}

function organize(operational, incoming) {
	var charter = operational.get("charter");

	if (charter.status().phase !== "awaiting-resources") {
		throw new Error("Project is not awaiting resources");
	}

	var expected = SEGMENTS.map(function (segment) {
		return "contract-" + segment;
	});

	if (
		incoming.keys().slice().sort().join(",") !==
			expected.slice().sort().join(",")
	) {
		throw new Error("Project requires exactly three worker contracts");
	}

	var mission = operational.get("mission");

	SEGMENTS.forEach(function (segment) {
		var child = charter.createTitle(
			segment,
			operational,
			"worker-" + segment
		);

		var outgoing = operational.outgoing();

		mission.createMission(
			segment,
			outgoing,
			"assignment"
		);

		incoming.move(
			"contract-" + segment,
			outgoing,
			"contract"
		);

		child.order(outgoing);
	});

	charter.setStatus({
		phase: "running",
		results: {}
	});
}

function collect(event, operational, incoming) {
	var charter = operational.get("charter");

	if (
		event.project !== charter.book().project ||
		event.role.length !== 1 ||
		SEGMENTS.indexOf(event.role[0]) === -1
	) {
		throw new Error("Unexpected project report");
	}

	if (
		incoming.keys().length !== 1 ||
		incoming.keys()[0] !== "result"
	) {
		throw new Error("Report requires one result memo");
	}

	var status = charter.status();
	var results = Object.assign({}, status.results);
	var segment = event.role[0];

	if (Object.prototype.hasOwnProperty.call(results, segment)) {
		throw new Error("Duplicate project result");
	}

	var result = incoming.get("result").data();

	if (
		!result ||
		typeof result.input !== "number" ||
		typeof result.output !== "number" ||
		!Number.isFinite(result.input) ||
		!Number.isFinite(result.output)
	) {
		throw new Error("Invalid worker result");
	}

	results[segment] = result;

	// The incoming official document is explicitly disposed of.
	incoming.destroy("result");

	charter.setStatus({
		phase: Object.keys(results).length === SEGMENTS.length
			? "completed"
			: "running",
		results: results
	});
}

function work(operational) {
	var charter = operational.get("charter");

	if (charter.status().phase !== "waiting") {
		throw new Error("Worker is not waiting");
	}

	var mission = operational.get("mission");
	var task = mission.task();

	if (
		!task ||
		typeof task.value !== "number" ||
		!Number.isFinite(task.value) ||
		!Number.isFinite(task.value * task.value)
	) {
		throw new Error("Worker requires a finite numeric task");
	}

	var outgoing = operational.outgoing();

	charter.createMemo({
		input: task.value,
		output: task.value * task.value
	}, outgoing, "result");

	mission.report(outgoing);

	charter.setStatus({
		phase: "completed",
		value: task.value * task.value
	});
}

function react(event, operational, incoming) {
	if (
		event.type === "suspended" ||
		event.type === "resumed"
	) {
		return;
	}

	if (
		event.type === "order" &&
		incoming.keys().indexOf("contract") !== -1
	) {
		initialize(operational, incoming);
		return;
	}

	var kind = operational.get("charter").book().kind;

	if (kind === "project-demo-root") {
		if (event.type === "order") {
			organize(operational, incoming);
			return;
		}

		if (event.type === "report") {
			collect(event, operational, incoming);
			return;
		}
	}

	if (
		kind === "project-demo-worker" &&
		event.type === "tick"
	) {
		work(operational);
		return;
	}

	throw new Error("Unsupported project demo event: " + event.type);
}

exports.browser = react;
exports.node = react;