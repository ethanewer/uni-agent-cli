#!/usr/bin/env node
// This process is intentionally tiny. A fail-closed operating-system sandbox is
// the security boundary; Node permissions and the VM are defense-in-depth layers.
import vm from "node:vm";
import { StringDecoder } from "node:string_decoder";

const MAX_FRAME = 1024 * 1024;
let input = "";
let started = false;
let context;
let deliverIntoContext;
let nextRequestId = 1;

function write(message) {
	const line = `${JSON.stringify(message)}\n`;
	if (Buffer.byteLength(line, "utf8") > MAX_FRAME) throw new Error("sandbox output frame is too large");
	process.stdout.write(line);
}

function fail(error) {
	write({ type: "fatal", error: sanitizeError(error) });
	process.exitCode = 1;
}

function sanitizeError(error) {
	return {
		name: String(error?.name ?? "Error").slice(0, 128),
		code: String(error?.code ?? "WORKFLOW_ERROR").slice(0, 128),
		message: String(error?.message ?? error ?? "Workflow failed").slice(0, 64 * 1024),
	};
}

function sendRequest(operation, payload) {
	try {
		if (typeof operation !== "string" || !operation) return 0;
		const id = nextRequestId++;
		write({ type: "request", id, operation, payload });
		return id;
	} catch (error) {
		// Crossing the transport bound is a run-fatal containment event, not a
		// script-level rejection that approved code may catch and continue past.
		try { fail(error); } finally { process.exit(1); }
	}
}
Object.setPrototypeOf(sendRequest, null);
Object.freeze(sendRequest);

const RUNTIME_BOOTSTRAP = String.raw`
(() => {
  const localeUnavailable = () => { throw new Error("locale-sensitive operations are unavailable in workflows"); };
  for (const [prototype, methods] of [
    [String.prototype, ["localeCompare"]],
    [Number.prototype, ["toLocaleString"]],
    [BigInt.prototype, ["toLocaleString"]],
    [Array.prototype, ["toLocaleString"]],
    [Object.prototype, ["toLocaleString"]],
  ]) {
    for (const method of methods) Object.defineProperty(prototype, method, { value: localeUnavailable, writable: false, configurable: false });
  }
  Object.defineProperty(Math, "random", { value: () => { throw new Error("randomness is unavailable in workflows"); } });
  Object.freeze(Math);
  Object.defineProperties(globalThis, {
    Date: { value: undefined },
    performance: { value: undefined },
    Intl: { value: undefined },
    crypto: { value: undefined },
	// V8's heap flag does not cap external ArrayBuffer/WebAssembly backing
	// stores. Workflow programs only need JSON values, so remove every direct
	// external-memory allocator before approved source can retain a reference.
	ArrayBuffer: { value: undefined },
	SharedArrayBuffer: { value: undefined },
	DataView: { value: undefined },
	Int8Array: { value: undefined }, Uint8Array: { value: undefined },
	Uint8ClampedArray: { value: undefined }, Int16Array: { value: undefined },
	Uint16Array: { value: undefined }, Int32Array: { value: undefined },
	Uint32Array: { value: undefined }, Float32Array: { value: undefined },
	Float64Array: { value: undefined }, BigInt64Array: { value: undefined },
	BigUint64Array: { value: undefined }, WebAssembly: { value: undefined },
  });
	const pending = new Map();
	const hostSend = __ccSend;
	const send = (operation, payload) => {
		const id = hostSend(operation, payload);
		if (!Number.isSafeInteger(id) || id < 1) throw new Error("workflow request could not cross the bounded sandbox channel");
		return id;
	};
	const initialArgs = JSON.parse(__ccArgsJson);
	const deepFreeze = (value, seen = new Set()) => {
		if (!value || typeof value !== "object" || seen.has(value)) return value;
		seen.add(value);
		for (const child of Object.values(value)) deepFreeze(child, seen);
		return Object.freeze(value);
	};
  const request = (operation, payload) => new Promise((resolve, reject) => {
	const id = send(operation, payload);
    pending.set(id, { resolve, reject });
  });
  const clone = (value) => value === undefined ? null : JSON.parse(JSON.stringify(value));
  const agent = (prompt, options = {}) => request("agent", { prompt: String(prompt), options: clone(options) });
  const workflow = (name, nestedArgs = null) => request("workflow", { name: String(name), args: clone(nestedArgs) });
  const phase = (title) => { send("phase", { title: String(title) }); };
  const log = (message) => { send("log", { message: String(message) }); };
  const parallel = async (thunks) => {
    if (!Array.isArray(thunks) || thunks.some((item) => typeof item !== "function")) throw new TypeError("parallel expects an array of functions");
    return Promise.all(thunks.map((thunk) => thunk()));
  };
  const pipeline = async (items, ...stages) => {
    if (!Array.isArray(stages) || stages.some((stage) => typeof stage !== "function")) throw new TypeError("pipeline stages must be functions");
    let current = [];
    for (const item of items) {
      let value = item;
      for (const stage of stages) value = await stage(value);
      current.push(value);
    }
    return current;
  };
	const __deliver = (id, ok, json) => {
    const entry = pending.get(id);
    if (!entry) return false;
    pending.delete(id);
		const value = JSON.parse(json);
    if (ok) entry.resolve(value);
    else {
      const error = new Error(String(value?.message ?? "Workflow operation failed"));
      error.name = String(value?.name ?? "Error");
      error.code = String(value?.code ?? "WORKFLOW_OPERATION_FAILED");
      entry.reject(error);
    }
    return true;
  };
  Object.defineProperties(globalThis, {
    agent: { value: Object.freeze(agent), enumerable: true },
    workflow: { value: Object.freeze(workflow), enumerable: true },
    parallel: { value: Object.freeze(parallel), enumerable: true },
    pipeline: { value: Object.freeze(pipeline), enumerable: true },
    phase: { value: Object.freeze(phase), enumerable: true },
    log: { value: Object.freeze(log), enumerable: true },
	args: { value: deepFreeze(initialArgs), enumerable: true },
    budget: { value: Object.freeze({
      total: __ccBudgetTotal,
      spent: () => request("budget", { query: "spent" }),
      remaining: () => request("budget", { query: "remaining" }),
    }), enumerable: true },
  });
	return Object.freeze(__deliver);
})();
`;

async function start(init) {
	if (started) throw new Error("sandbox was initialized twice");
	started = true;
	if (!init || init.type !== "init" || typeof init.source !== "string") throw new Error("invalid sandbox initialization");
	context = vm.createContext(Object.create(null), {
		name: "cc-dynamic-workflow",
		codeGeneration: { strings: false, wasm: false },
	});
	Object.defineProperties(context, {
		__ccSend: { value: sendRequest, configurable: true },
		__ccArgsJson: { value: JSON.stringify(init.args ?? null), configurable: true },
		__ccBudgetTotal: { value: init.tokenBudget ?? null, configurable: true },
	});
	deliverIntoContext = vm.runInContext(RUNTIME_BOOTSTRAP, context, { timeout: 1000, displayErrors: true });
	delete context.__ccSend;
	delete context.__ccArgsJson;
	delete context.__ccBudgetTotal;
	const execution = new vm.Script(init.source, { filename: "approved-workflow.js", displayErrors: true })
		.runInContext(context, { timeout: init.syncTimeoutMs ?? 1000, displayErrors: true });
	try {
		const result = await execution;
		write({ type: "result", value: result === undefined ? null : structuredClone(result) });
	} catch (error) {
		write({ type: "fatal", error: sanitizeError(error) });
		process.exitCode = 1;
	}
}

function deliver(message) {
	if (!context || !Number.isSafeInteger(message.id) || message.id < 1 || typeof message.ok !== "boolean") {
		throw new Error("invalid sandbox response");
	}
	const json = JSON.stringify(message.ok ? message.value : sanitizeError(message.error));
	if (Buffer.byteLength(json, "utf8") > MAX_FRAME) throw new Error("sandbox response is too large");
	const delivered = deliverIntoContext(message.id, message.ok, json);
	if (!delivered) throw new Error(`unknown or duplicate sandbox request ${message.id}`);
}

function receive(message) {
	if (message?.type === "init") void start(message).catch(fail);
	else if (message?.type === "response") deliver(message);
	else if (message?.type === "cancel") process.exit(0);
	else throw new Error("unknown sandbox input");
}

const decoder = new StringDecoder("utf8");
process.stdin.on("data", (chunk) => {
	input += decoder.write(chunk);
	if (Buffer.byteLength(input, "utf8") > MAX_FRAME) return fail(new Error("sandbox input frame is too large"));
	let newline;
	while ((newline = input.indexOf("\n")) >= 0) {
		const line = input.slice(0, newline);
		input = input.slice(newline + 1);
		if (!line) continue;
		try { receive(JSON.parse(line)); } catch (error) { fail(error); }
	}
});
process.stdin.on("end", () => {
	input += decoder.end();
	if (!started) fail(new Error("sandbox closed before initialization"));
});

setInterval(() => write({ type: "heartbeat" }), 1000).unref();
