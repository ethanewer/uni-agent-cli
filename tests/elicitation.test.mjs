import assert from "node:assert/strict";
import {
	ELICITATION_LIMITS,
	normalizeElicitationFormRequest,
	normalizeElicitationResponse,
	safeElicitationDisplayText,
	validateElicitationFieldValue,
} from "../src/harness/elicitation.mjs";
import { AcpClient, ElicitationFormPanel, HarnessApp, localIdentityResponse } from "../src/pi-harness.mjs";

const fullRequest = {
	mode: "form",
	message: "Configure the run",
	requestedSchema: {
		type: "object",
		title: "Run configuration",
		description: "Values are sent directly to the agent.",
		properties: {
			name: { type: "string", title: "Name", minLength: 1, maxLength: 20, pattern: "^[A-Za-z]+$" },
			password: { type: "string", title: "Password", minLength: 3, _meta: { sensitive: true } },
			ratio: { type: "number", title: "Ratio", minimum: 0, maximum: 2 },
			count: { type: "integer", title: "Count", minimum: 1, maximum: 5 },
			enabled: { type: "boolean", title: "Enabled", default: true },
			strategy: {
				type: "string",
				title: "Strategy",
				oneOf: [
					{ const: "safe", title: "Safe" },
					{ const: "fast", title: "Fast", description: "Use more concurrency" },
				],
				default: "fast",
			},
			tags: {
				type: "array",
				title: "Tags",
				items: { anyOf: [{ const: "a", title: "Alpha" }, { const: "b", title: "Beta" }] },
				minItems: 1,
				maxItems: 2,
				default: ["a"],
			},
			optionalNote: { type: "string", title: "Optional note" },
		},
		required: ["name", "password", "ratio", "count", "enabled", "strategy", "tags"],
	},
};

{
	const form = normalizeElicitationFormRequest(fullRequest);
	assert.equal(form.title, "Run configuration");
	assert.deepEqual(form.fields.map((field) => field.type), [
		"string", "string", "number", "integer", "boolean", "string", "array", "string",
	]);
	assert.equal(form.fields[1].secret, true);
	assert.equal(form.fields[5].options[1].description, "Use more concurrency");
	assert.deepEqual(form.fields[6].default, ["a"]);

	assert.deepEqual(validateElicitationFieldValue(form.fields[0], "Alice"), { ok: true, value: "Alice" });
	assert.equal(validateElicitationFieldValue(form.fields[0], "Alice 1").ok, false);
	assert.equal(validateElicitationFieldValue(form.fields[2], "3").ok, false);
	assert.equal(validateElicitationFieldValue(form.fields[3], "1.5").ok, false);
	assert.deepEqual(validateElicitationFieldValue(form.fields[7], ""), { ok: true, omit: true });
	const optionalArray = { ...form.fields[6], required: false };
	assert.deepEqual(validateElicitationFieldValue(optionalArray, undefined), { ok: true, omit: true });
	assert.deepEqual(validateElicitationFieldValue({ ...optionalArray, minItems: undefined }, []), { ok: true, value: [] });
}

// Secret inference also uses the sanitized description, since backends often
// keep the property name and title generic while explaining the credential in
// prose.
{
	const field = normalizeElicitationFormRequest({
		mode: "form",
		message: "Credentials",
		requestedSchema: {
			type: "object",
			properties: {
				value: {
					type: "string",
					title: "Value",
					description: "Enter your API\x1b[2m token\x1b[0m",
				},
			},
		},
	}).fields[0];
	assert.equal(field.description, "Enter your API token");
	assert.equal(field.secret, true);
}

// Optional multi-selects distinguish omission from an explicit empty array.
// The virtual Skip row omits the property; moving to an option without toggling
// it and continuing submits [] when the schema permits zero selections.
{
	const form = normalizeElicitationFormRequest({
		mode: "form",
		message: "Optional tags",
		requestedSchema: {
			type: "object",
			properties: { tags: { type: "array", items: { type: "string", enum: ["a", "b"] } } },
		},
	});
	let skipped;
	const skipPanel = new ElicitationFormPanel(form, (value) => { skipped = value; });
	assert.match(skipPanel.render(100).join("\n"), /Skip this optional field/);
	skipPanel.handleInput("\r");
	skipPanel.handleInput("\r");
	assert.deepEqual({ ...skipped.content }, {});

	let empty;
	const emptyPanel = new ElicitationFormPanel(form, (value) => { empty = value; });
	emptyPanel.handleInput("\x1b[A");
	emptyPanel.handleInput("\r");
	emptyPanel.handleInput("\r");
	assert.deepEqual({ ...empty.content }, { tags: [] });
}

{
	const formats = (format) => normalizeElicitationFormRequest({
		mode: "form",
		message: "Format",
		requestedSchema: { type: "object", properties: { value: { type: "string", format } }, required: ["value"] },
	}).fields[0];
	assert.equal(validateElicitationFieldValue(formats("email"), "person@example.com").ok, true);
	assert.equal(validateElicitationFieldValue(formats("email"), "not-an-email").ok, false);
	assert.equal(validateElicitationFieldValue(formats("uri"), "https://example.test/path").ok, true);
	assert.equal(validateElicitationFieldValue(formats("date"), "2024-02-29").ok, true);
	assert.equal(validateElicitationFieldValue(formats("date"), "2023-02-29").ok, false);
	assert.equal(validateElicitationFieldValue(formats("date-time"), "2026-07-11T12:30:00Z").ok, true);
}

// Backend-provided patterns run on the main thread, so accept only the bounded
// safe subset. In particular, adjacent unbounded repetitions are rejected even
// without a repeated group.
{
	for (const pattern of ["a+a+$", "a*a+$", "a{1,}a+$", "[a-z]+[a-z]+$"]) {
		assert.throws(() => normalizeElicitationFormRequest({
			mode: "form",
			message: "Unsafe pattern",
			requestedSchema: { type: "object", properties: { value: { type: "string", pattern } } },
		}), /too complex to evaluate safely/u);
	}
	for (const pattern of ["^[A-Za-z0-9_.-]+$", "^[A-Z]{2}-\\d{4}$", "^(yes|no)$"]) {
		const field = normalizeElicitationFormRequest({
			mode: "form",
			message: "Safe pattern",
			requestedSchema: { type: "object", properties: { value: { type: "string", pattern } } },
		}).fields[0];
		assert.equal(field.pattern, pattern);
	}
}

// Integer instances and defaults remain safe integers, while JSON Schema's
// minimum and maximum keywords may be fractional numbers.
{
	const field = normalizeElicitationFormRequest({
		mode: "form",
		message: "Integer bounds",
		requestedSchema: {
			type: "object",
			properties: { count: { type: "integer", minimum: 1.25, maximum: 3.75, default: 2 } },
			required: ["count"],
		},
	}).fields[0];
	assert.equal(field.minimum, 1.25);
	assert.equal(field.maximum, 3.75);
	assert.equal(field.default, 2);
	assert.deepEqual(validateElicitationFieldValue(field, "2"), { ok: true, value: 2 });
	assert.equal(validateElicitationFieldValue(field, "1").ok, false);
	assert.equal(validateElicitationFieldValue(field, "4").ok, false);
	assert.equal(validateElicitationFieldValue(field, "2.5").ok, false);
	assert.throws(() => normalizeElicitationFormRequest({
		mode: "form",
		message: "Fractional default",
		requestedSchema: { type: "object", properties: { count: { type: "integer", default: 2.5 } } },
	}), /safe integer/u);
}

{
	assert.equal(localIdentityResponse("who are you?"), "I’m cc, a CLI that helps you switch between agent backends and manage the surrounding TUI/workflow.");
	assert.equal(localIdentityResponse("What are you"), "I’m cc, a CLI that helps you switch between agent backends and manage the surrounding TUI/workflow.");
	assert.equal(localIdentityResponse("who am I?"), undefined, "user-directed identity questions belong to the backend");
	assert.equal(
		localIdentityResponse("who are you?", [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]),
		undefined,
		"structured prompts must retain their backend context",
	);
	assert.equal(localIdentityResponse("hello there"), undefined);
}

{
	assert.equal(safeElicitationDisplayText("safe\x1b[2J\x1b]0;owned\x07\n\u202etext"), "safe text");
	assert.equal(normalizeElicitationFormRequest({
		mode: "form",
		message: "Confirm",
		requestedSchema: { type: null, title: null, required: null },
	}).fields.length, 0);
	const invalidRequests = [
		{ type: "array", properties: { x: { type: "string" } } },
		{ type: "object", properties: { x: { type: "object" } } },
		{ type: "object", properties: { x: { type: "string", enum: ["a"], oneOf: [{ const: "a", title: "A" }] } } },
		{ type: "object", properties: { x: { type: "string", pattern: "^(a+)+$" } } },
		{ type: "object", properties: { x: { type: "integer", default: Number.MAX_SAFE_INTEGER + 1 } } },
		{ type: "object", properties: { x: { type: "array", items: { type: "number", enum: [1] } } } },
		{ type: "object", properties: { "bad\x1b[2J": { type: "string" } } },
		JSON.parse('{"type":"object","properties":{"__proto__":{"type":"string"}}}'),
	];
	for (const requestedSchema of invalidRequests) {
		assert.throws(() => normalizeElicitationFormRequest({ mode: "form", message: "Invalid", requestedSchema }));
	}
	const tooMany = Object.fromEntries(Array.from({ length: ELICITATION_LIMITS.fields + 1 }, (_, index) => [`f${index}`, { type: "string" }]));
	assert.throws(() => normalizeElicitationFormRequest({
		mode: "form",
		message: "Too many",
		requestedSchema: { type: "object", properties: tooMany },
	}));
}

{
	const accepted = normalizeElicitationResponse(fullRequest, {
		action: "accept",
		content: {
			name: "Alice",
			password: "secret-value",
			ratio: 1.5,
			count: 3,
			enabled: true,
			strategy: "fast",
			tags: ["a"],
		},
	});
	assert.equal(accepted.action, "accept");
	assert.equal(accepted.content.password, "secret-value");
	assert.deepEqual(normalizeElicitationResponse(fullRequest, { action: "accept", content: { name: "missing fields" } }), { action: "cancel" });
	assert.deepEqual(normalizeElicitationResponse(fullRequest, { action: "accept", content: { unknown: "value" } }), { action: "cancel" });
	assert.deepEqual(normalizeElicitationResponse({ mode: "url" }, { action: "accept", content: { ignored: true } }), { action: "accept" });
	assert.deepEqual(normalizeElicitationResponse({ mode: "future" }, { action: "accept" }), { action: "cancel" });
}

// Form values are collected sequentially. Secret input is masked, and the final
// confirmation reports only presence—not values—before producing canonical ACP
// content.
{
	const form = normalizeElicitationFormRequest(fullRequest);
	const results = [];
	const panel = new ElicitationFormPanel(form, (result) => results.push(result));
	for (const character of "Alice") panel.handleInput(character);
	panel.handleInput("\r");
	for (const character of "secret-value") panel.handleInput(character);
	const secretFrame = panel.render(100).join("\n");
	assert.ok(secretFrame.includes("••••"));
	assert.ok(!secretFrame.includes("secret-value"));
	panel.handleInput("\r");
	for (const character of "1.5") panel.handleInput(character);
	panel.handleInput("\r");
	for (const character of "3") panel.handleInput(character);
	panel.handleInput("\r");
	panel.handleInput("\r"); // boolean default true
	panel.handleInput("\r"); // oneOf default fast
	panel.handleInput("\r"); // multi-select default [a]
	panel.handleInput("\r"); // omit the optional blank string
	assert.equal(panel.stage, "review");
	const reviewFrame = panel.render(100).join("\n");
	for (const value of ["Alice", "secret-value", "1.5", "fast", "Alpha"]) assert.ok(!reviewFrame.includes(value));
	panel.handleInput("\r");
	assert.equal(results.length, 1);
	assert.equal(results[0].action, "accept");
	assert.deepEqual({ ...results[0].content }, {
		name: "Alice",
		password: "secret-value",
		ratio: 1.5,
		count: 3,
		enabled: true,
		strategy: "fast",
		tags: ["a"],
	});
	panel.cancel();
	assert.equal(results.length, 1, "a settled form cannot answer twice");
}

{
	const form = normalizeElicitationFormRequest({
		mode: "form",
		message: "Pick",
		requestedSchema: {
			type: "object",
			properties: { choices: { type: "array", items: { type: "string", enum: ["a", "b"] }, minItems: 1, maxItems: 1 } },
			required: ["choices"],
		},
	});
	let result;
	const panel = new ElicitationFormPanel(form, (value) => { result = value; });
	panel.handleInput(" ");
	panel.handleInput("\r");
	assert.equal(panel.stage, "review");
	panel.handleInput("\x1b[B");
	panel.handleInput("\r");
	assert.deepEqual(result, { action: "decline" });
}

// Capability negotiation is mode-specific: legacy callback embedders retain URL
// support, while cc's explicit form-capable handler advertises both modes.
await (async () => {
	const initializeWith = async (options) => {
		const requests = [];
		const client = new AcpClient({ command: "fake" }, () => {}, options);
		client.start = () => {};
		client.request = async (method, params) => {
			requests.push({ method, params });
			if (method === "initialize") return { agentCapabilities: {}, agentInfo: {}, authMethods: [] };
			if (method === "session/new") return { sessionId: "s" };
			return {};
		};
		await client.initialize();
		return requests[0].params.clientCapabilities;
	};
	assert.deepEqual((await initializeWith({ onElicitationRequest: async () => ({ action: "cancel" }) })).elicitation, { url: {} });
	assert.deepEqual((await initializeWith({
		onElicitationRequest: async () => ({ action: "cancel" }),
		elicitationCapabilities: { url: true, form: true },
	})).elicitation, { url: {}, form: {} });
	assert.equal(Object.hasOwn(await initializeWith({}), "elicitation"), false);
})();

// The JSON-RPC request path revalidates host output against the advertised form
// schema before returning it to the agent.
await (async () => {
	const writes = [];
	const client = Object.create(AcpClient.prototype);
	client.pending = new Map();
	client.bufferingSessionUpdates = false;
	client.onEvent = () => {};
	client.writeSafe = (message) => writes.push(message);
	client.onElicitationRequest = async () => ({
		action: "accept",
		content: {
			name: "Alice",
			password: "secret-value",
			ratio: 1.5,
			count: 3,
			enabled: true,
			strategy: "fast",
			tags: ["a"],
		},
	});
	client.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 7, method: "elicitation/create", params: fullRequest }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.equal(writes[0].id, 7);
	assert.equal(writes[0].result.action, "accept");
	assert.equal(writes[0].result.content.password, "secret-value");

	client.onElicitationRequest = async () => ({ action: "accept", content: { injected: true } });
	client.handleLine(JSON.stringify({ jsonrpc: "2.0", id: 8, method: "elicitation/create", params: fullRequest }));
	await new Promise((resolve) => setTimeout(resolve, 0));
	assert.deepEqual(writes[1].result, { action: "cancel" });
})();

// A queued request from a retired connection is cancelled without opening UI;
// an active request whose session changes before submission is also cancelled.
{
	const oldClient = { sessionId: "old", exited: false, stopping: false };
	const app = Object.create(HarnessApp.prototype);
	app.client = { sessionId: "new" };
	app.permissionQueue = [];
	app.permissionPromptActive = false;
	app.activeInteractiveRequest = undefined;
	let opened = false;
	let result;
	app.openElicitationRequest = () => { opened = true; };
	app.permissionQueue.push({
		kind: "elicitation",
		params: { mode: "form", sessionId: "old" },
		context: { sourceClient: oldClient },
		resolve: (value) => { result = value; },
	});
	app.drainPermissionQueue();
	assert.equal(opened, false);
	assert.deepEqual(result, { action: "cancel" });
}

{
	const sourceClient = { sessionId: "one", exited: false, stopping: false };
	const app = Object.create(HarnessApp.prototype);
	app.client = sourceClient;
	app.permissionPromptActive = true;
	app.activeInteractiveRequest = undefined;
	app.closeMenu = () => {};
	app.drainPermissionQueue = () => {};
	app.addNotice = () => {};
	let finishForm;
	app.openElicitationForm = (_form, finish) => { finishForm = finish; };
	let result;
	const request = {
		kind: "elicitation",
		params: {
			mode: "form",
			sessionId: "one",
			message: "Name",
			requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
		},
		context: { sourceClient },
		resolve: (value) => { result = value; },
	};
	app.activeInteractiveRequest = request;
	app.openElicitationRequest(request);
	sourceClient.sessionId = "two";
	finishForm({ action: "accept", content: { name: "Alice" } });
	assert.deepEqual(result, { action: "cancel" });
}

console.log("elicitation: all checks passed");
