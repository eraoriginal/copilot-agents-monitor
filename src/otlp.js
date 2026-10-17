/**
 * OTLP/JSON decoding. Copilot Chat exports `http/json` by default; each request is an
 * `ExportTraceServiceRequest` (or its logs and metrics siblings) in the protobuf JSON mapping.
 */

/** An OTLP `AnyValue` as a plain JavaScript value. int64 arrives as a string. */
export function anyValue(value) {
	if (value == null) return null;
	if ("stringValue" in value) return value.stringValue;
	if ("boolValue" in value) return value.boolValue;
	if ("intValue" in value) return Number(value.intValue);
	if ("doubleValue" in value) return Number(value.doubleValue);
	if ("arrayValue" in value) return (value.arrayValue?.values ?? []).map(anyValue);
	if ("kvlistValue" in value) return attributes(value.kvlistValue?.values);
	if ("bytesValue" in value) return value.bytesValue;
	return null;
}

export function attributes(list) {
	const out = {};
	for (const entry of list ?? []) out[entry.key] = anyValue(entry.value);
	return out;
}

/** Nanoseconds since the epoch, as a string or a number, to milliseconds; 0 means unset. */
export function nanosToMillis(value) {
	if (value == null || value === "" || value === "0" || value === 0) return null;
	if (typeof value === "string") return Number(BigInt(value) / 1_000_000n);
	return Math.floor(value / 1e6);
}

function emptyToNull(id) {
	return typeof id === "string" && id.length > 0 && !/^0+$/.test(id) ? id : null;
}

/** Flattens an `ExportTraceServiceRequest` into one record per span. */
export function flattenTraces(body) {
	const spans = [];
	for (const resourceSpans of body?.resourceSpans ?? []) {
		const resource = attributes(resourceSpans.resource?.attributes);
		for (const scopeSpans of resourceSpans.scopeSpans ?? []) {
			for (const span of scopeSpans.spans ?? []) {
				spans.push({
					traceId: span.traceId,
					spanId: span.spanId,
					parentSpanId: emptyToNull(span.parentSpanId),
					name: span.name,
					kind: span.kind ?? null,
					start: nanosToMillis(span.startTimeUnixNano),
					end: nanosToMillis(span.endTimeUnixNano),
					attributes: attributes(span.attributes),
					status: span.status ?? null,
					events: (span.events ?? []).map((event) => ({
						name: event.name,
						time: nanosToMillis(event.timeUnixNano),
						attributes: attributes(event.attributes),
					})),
					service: resource["service.name"] ?? null,
					scope: scopeSpans.scope?.name ?? null,
				});
			}
		}
	}
	return spans;
}

/** Flattens an `ExportLogsServiceRequest` into one record per log event. */
export function flattenLogs(body) {
	const records = [];
	for (const resourceLogs of body?.resourceLogs ?? []) {
		const resource = attributes(resourceLogs.resource?.attributes);
		for (const scopeLogs of resourceLogs.scopeLogs ?? []) {
			for (const log of scopeLogs.logRecords ?? []) {
				const attrs = attributes(log.attributes);
				records.push({
					time: nanosToMillis(log.timeUnixNano) ?? nanosToMillis(log.observedTimeUnixNano),
					name: log.eventName ?? attrs["event.name"] ?? null,
					body: anyValue(log.body),
					attributes: attrs,
					traceId: emptyToNull(log.traceId),
					spanId: emptyToNull(log.spanId),
					service: resource["service.name"] ?? null,
				});
			}
		}
	}
	return records;
}
