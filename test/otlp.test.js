import assert from "node:assert/strict";
import { test } from "node:test";
import { anyValue, flattenLogs, flattenTraces, nanosToMillis } from "../src/otlp.js";

test("anyValue turns OTLP values into plain values, int64 strings included", () => {
	assert.equal(anyValue({ stringValue: "lead" }), "lead");
	assert.equal(anyValue({ intValue: "62936000" }), 62936000);
	assert.equal(anyValue({ doubleValue: 0.5 }), 0.5);
	assert.equal(anyValue({ boolValue: false }), false);
	assert.deepEqual(anyValue({ arrayValue: { values: [{ stringValue: "stop" }] } }), ["stop"]);
	assert.deepEqual(
		anyValue({ kvlistValue: { values: [{ key: "a", value: { intValue: "1" } }] } }),
		{ a: 1 },
	);
});

test("nanosToMillis reads string and number nanoseconds, and treats 0 as unset", () => {
	assert.equal(nanosToMillis("1792272312794000000"), 1792272312794);
	assert.equal(nanosToMillis(1_500_000), 1);
	assert.equal(nanosToMillis("0"), null);
	assert.equal(nanosToMillis(undefined), null);
});

test("flattenTraces yields one record per span with its resource's service", () => {
	const spans = flattenTraces({
		resourceSpans: [
			{
				resource: { attributes: [{ key: "service.name", value: { stringValue: "github-copilot" } }] },
				scopeSpans: [
					{
						scope: { name: "github.copilot" },
						spans: [
							{
								traceId: "20417866f8a54b3682864650594501df",
								spanId: "b66619db6f099419",
								parentSpanId: "",
								name: "invoke_agent lead",
								startTimeUnixNano: "1792273394780000000",
								endTimeUnixNano: "1792273394793000000",
								attributes: [{ key: "gen_ai.agent.name", value: { stringValue: "lead" } }],
								status: { code: 0 },
							},
						],
					},
				],
			},
		],
	});
	assert.equal(spans.length, 1);
	assert.deepEqual(
		{ ...spans[0], events: undefined },
		{
			traceId: "20417866f8a54b3682864650594501df",
			spanId: "b66619db6f099419",
			parentSpanId: null,
			name: "invoke_agent lead",
			kind: null,
			start: 1792273394780,
			end: 1792273394793,
			attributes: { "gen_ai.agent.name": "lead" },
			status: { code: 0 },
			events: undefined,
			service: "github-copilot",
			scope: "github.copilot",
		},
	);
});

test("flattenTraces and flattenLogs accept an empty request", () => {
	assert.deepEqual(flattenTraces({}), []);
	assert.deepEqual(flattenLogs({ resourceLogs: [] }), []);
});
