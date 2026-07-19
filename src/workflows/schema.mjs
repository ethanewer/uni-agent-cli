import Ajv from "ajv";
import { Worker } from "node:worker_threads";

const cache = new Map();
const MAX_CACHE_ENTRIES = 64;
const MAX_CACHE_KEY_BYTES = 1024 * 1024;
let cacheKeyBytes = 0;

function rejectUnboundedSchemaFeatures(schema, path = "$") {
	if (typeof schema === "boolean" || !schema || typeof schema !== "object" || Array.isArray(schema)) return;
	for (const key of ["pattern", "patternProperties"]) {
		if (Object.hasOwn(schema, key)) throw new Error(`workflow schemas cannot use ${key} because JavaScript regular-expression validation is not time-bounded (${path})`);
	}
	for (const key of ["$ref", "$dynamicRef", "$recursiveRef"]) {
		if (Object.hasOwn(schema, key)) throw new Error(`workflow schemas cannot use ${key} because reference expansion is not time-bounded (${path})`);
	}
	for (const key of ["additionalProperties", "additionalItems", "contains", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems", "contentSchema"]) {
		if (Object.hasOwn(schema, key)) rejectUnboundedSchemaFeatures(schema[key], `${path}.${key}`);
	}
	for (const key of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
		if (Array.isArray(schema[key])) schema[key].forEach((entry, index) => rejectUnboundedSchemaFeatures(entry, `${path}.${key}[${index}]`));
	}
	if (Object.hasOwn(schema, "items")) {
		if (Array.isArray(schema.items)) schema.items.forEach((entry, index) => rejectUnboundedSchemaFeatures(entry, `${path}.items[${index}]`));
		else rejectUnboundedSchemaFeatures(schema.items, `${path}.items`);
	}
	for (const key of ["properties", "$defs", "definitions", "dependentSchemas"]) {
		if (!schema[key] || typeof schema[key] !== "object" || Array.isArray(schema[key])) continue;
		for (const [member, memberSchema] of Object.entries(schema[key])) rejectUnboundedSchemaFeatures(memberSchema, `${path}.${key}[${JSON.stringify(member)}]`);
	}
	if (schema.dependencies && typeof schema.dependencies === "object" && !Array.isArray(schema.dependencies)) {
		for (const [member, dependency] of Object.entries(schema.dependencies)) {
			if (!Array.isArray(dependency)) rejectUnboundedSchemaFeatures(dependency, `${path}.dependencies[${JSON.stringify(member)}]`);
		}
	}
}

export function compileWorkflowSchema(schema) {
	const key = JSON.stringify(schema);
	const bytes = Buffer.byteLength(key, "utf8");
	if (bytes > 64 * 1024) throw new Error("workflow schema is too large");
	rejectUnboundedSchemaFeatures(schema);
	if (cache.has(key)) {
		const validate = cache.get(key).validate;
		cache.delete(key);
		cache.set(key, { validate, bytes });
		return validate;
	}
	// Ajv retains every compiled schema in its instance-level cache. Give each
	// cache entry its own instance so LRU eviction releases both the validator and
	// Ajv's generated-code/schema caches instead of only dropping our wrapper.
	const ajv = new Ajv({ allErrors: true, strict: true, validateSchema: true, maxErrors: 32 });
	const validate = ajv.compile(schema);
	cache.set(key, { validate, bytes });
	cacheKeyBytes += bytes;
	while (cache.size > MAX_CACHE_ENTRIES || cacheKeyBytes > MAX_CACHE_KEY_BYTES) {
		const oldest = cache.entries().next().value;
		if (!oldest) break;
		cache.delete(oldest[0]);
		cacheKeyBytes -= oldest[1].bytes;
	}
	return validate;
}

export function workflowSchemaCacheStats() {
	return Object.freeze({ entries: cache.size, keyBytes: cacheKeyBytes, maxEntries: MAX_CACHE_ENTRIES, maxKeyBytes: MAX_CACHE_KEY_BYTES });
}

export function validateWorkflowSchema(schema, value) {
	const validate = compileWorkflowSchema(schema);
	const ok = validate(value);
	return ok ? { ok: true, value } : {
		ok: false,
		errors: (validate.errors ?? []).slice(0, 32).map((entry) => `${entry.instancePath || "/"} ${entry.message}`),
	};
}

export async function validateWorkflowSchemaBounded(schema, value, options = {}) {
	const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 1000, 5000));
	return await new Promise((resolve, reject) => {
		const worker = new Worker(new URL("./schema-worker.mjs", import.meta.url), {
			workerData: { schema, value },
		});
		let settled = false;
		const finish = (error, result) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", onAbort);
			void worker.terminate().then(() => {
				if (error) reject(error); else resolve(result);
			}, (terminationError) => {
				reject(new AggregateError(
					[...(error ? [error] : []), terminationError],
					"workflow schema validator could not be confirmed stopped",
				));
			});
		};
		const onAbort = () => finish(options.signal.reason instanceof Error ? options.signal.reason : new Error("workflow schema validation cancelled"));
		const timer = setTimeout(() => finish(Object.assign(new Error("workflow schema validation exceeded its CPU deadline"), { code: "WORKFLOW_SCHEMA_TIMEOUT" })), timeoutMs);
		worker.once("message", (message) => {
			if (message?.ok === true) finish(undefined, message.result);
			else finish(Object.assign(new Error(String(message?.error?.message ?? "workflow schema validation failed")), { code: String(message?.error?.code ?? "WORKFLOW_SCHEMA_FAILED") }));
		});
		worker.once("error", (error) => finish(error));
		worker.once("exit", (code) => { if (!settled) finish(new Error(`workflow schema validator exited (${code})`)); });
		if (options.signal?.aborted) onAbort();
		else options.signal?.addEventListener("abort", onAbort, { once: true });
	});
}

export function extractWorkflowJson(text) {
	const source = String(text ?? "").trim();
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/iu.exec(source);
	return JSON.parse(fenced ? fenced[1] : source);
}
