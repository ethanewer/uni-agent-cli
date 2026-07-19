import { randomBytes, timingSafeEqual } from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WORKFLOW_LIMITS } from "./types.mjs";

const MCP_SERVER = fileURLToPath(new URL("./mcp-server.mjs", import.meta.url));

function equalToken(left, right) {
	const a = Buffer.from(String(left ?? ""));
	const b = Buffer.from(String(right ?? ""));
	return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

function boundedResponseId(value) {
	if (Number.isSafeInteger(value)) return value;
	if (typeof value === "string" && Buffer.byteLength(value, "utf8") <= 256) return value;
	return null;
}

export class WorkflowBroker {
	constructor({ stateRoot, handle, io = {} }) {
		this.stateRoot = stateRoot;
		this.handle = handle;
		this.createServer = io.createServer ?? ((listener) => net.createServer(listener));
		this.mkdtemp = io.mkdtemp ?? ((...args) => fs.mkdtemp(...args));
		this.lstat = io.lstat ?? ((...args) => fs.lstat(...args));
		this.realpath = io.realpath ?? ((...args) => fs.realpath(...args));
		this.chmod = io.chmod ?? ((...args) => fs.chmod(...args));
		this.unlink = io.unlink ?? ((...args) => fs.unlink(...args));
		this.rmdir = io.rmdir ?? ((...args) => fs.rmdir(...args));
		this.tokens = new Map();
		this.sockets = new Set();
		this.inFlightRequests = 0;
		this.server = undefined;
		this.endpoint = undefined;
		this.endpointDirectory = undefined;
		this.startPromise = undefined;
		this.failed = false;
	}

	async start() {
		if (this.server) return;
		if (this.startPromise) return this.startPromise;
		this.startPromise = this.#start().finally(() => { this.startPromise = undefined; });
		return this.startPromise;
	}

	async #start() {
		const nonce = randomBytes(12).toString("hex");
		let endpoint;
		let endpointDirectory;
		let server;
		try {
			if (process.platform === "win32") endpoint = `\\\\.\\pipe\\cc-workflow-${process.pid}-${nonce}`;
			else {
				// AF_UNIX paths are short on both Darwin and Linux, while TMPDIR can be
				// arbitrarily long. Use the standard short POSIX temp root and create an
				// atomically private directory so there is no bind-to-chmod window.
				const directory = await this.realpath("/tmp");
				endpointDirectory = await this.mkdtemp(path.join(directory, `cc-wf-${process.getuid?.() ?? "user"}-${nonce}-`));
				const stat = await this.lstat(endpointDirectory);
				if (!stat.isDirectory() || stat.isSymbolicLink() ||
					(typeof process.getuid === "function" && stat.uid !== process.getuid()) ||
					(stat.mode & 0o077) !== 0 || await this.realpath(endpointDirectory) !== endpointDirectory) {
					throw new Error("workflow broker endpoint directory must be an owned private directory");
				}
				endpoint = path.join(endpointDirectory, "broker.sock");
			}
			server = this.createServer((socket) => this.#connection(socket));
			server.on("error", (error) => this.#serverError(server, error));
			await new Promise((resolve, reject) => {
				server.once("error", reject);
				server.listen(endpoint, () => { server.off("error", reject); resolve(); });
			});
			if (process.platform !== "win32") await this.chmod(endpoint, 0o600);
			// Do not publish a usable broker until the socket is listening and its
			// owner-only permissions have been applied successfully.
			this.server = server;
			this.endpoint = endpoint;
			this.endpointDirectory = endpointDirectory;
			this.failed = false;
		} catch (error) {
			for (const socket of this.sockets) socket.destroy();
			if (server?.listening) await new Promise((resolve) => server.close(() => resolve()));
			if (process.platform !== "win32" && endpoint) await this.unlink(endpoint).catch(() => {});
			if (endpointDirectory) await this.rmdir(endpointDirectory).catch(() => {});
			throw error;
		}
	}

	#serverError(server, error) {
		// A listening server can still emit an operational error later. Fence new
		// grants and cancel every in-flight request instead of letting an unhandled
		// EventEmitter error terminate the entire TUI.
		if (this.server !== server) return;
		this.lastError = error;
		this.failed = true;
		for (const token of [...this.tokens.keys()]) this.revoke(token);
		for (const socket of this.sockets) socket.destroy();
	}

	issue(owner, options = {}) {
		if (!this.endpoint || this.failed) return undefined;
		const token = randomBytes(32).toString("base64url");
		this.tokens.set(token, { owner, controllers: new Set() });
		return {
			name: "cc-dynamic-workflows",
			command: process.execPath,
			args: [MCP_SERVER],
			env: [
				{ name: "CC_WORKFLOW_BROKER_ENDPOINT", value: this.endpoint },
				{ name: "CC_WORKFLOW_BROKER_TOKEN", value: token },
				{ name: "CC_WORKFLOW_MODE", value: options.mode ?? "flexible" },
			],
		};
	}

	revoke(token) {
		const grant = this.tokens.get(token);
		this.tokens.delete(token);
		for (const controller of grant?.controllers ?? []) {
			controller.abort(Object.assign(new Error("workflow broker authorization was revoked"), { code: "BROKER_REVOKED" }));
		}
	}

	#connection(socket) {
		if (this.sockets.size >= WORKFLOW_LIMITS.maxBrokerSockets) {
			socket.destroy();
			return;
		}
		let input = "";
		const requests = new Set();
		const acknowledgements = new Map();
		this.sockets.add(socket);
		const close = () => {
			this.sockets.delete(socket);
			for (const controller of requests) controller.abort(Object.assign(new Error("workflow broker client disconnected"), { code: "BROKER_DISCONNECTED" }));
			requests.clear();
			for (const pending of acknowledgements.values()) pending.reject(Object.assign(new Error("workflow broker client disconnected before acknowledging its response"), { code: "BROKER_RESPONSE_UNACKNOWLEDGED" }));
			acknowledgements.clear();
		};
		socket.once("close", close);
		// ECONNRESET/EPIPE on an accepted socket otherwise becomes an uncaught
		// EventEmitter error and can terminate the whole CLI. `close` performs the
		// actual request cancellation and is idempotent when invoked from both paths.
		socket.on("error", close);
		socket.setEncoding("utf8");
		socket.on("data", (chunk) => {
			input += chunk;
			if (Buffer.byteLength(input, "utf8") > WORKFLOW_LIMITS.maxRpcBytes) return socket.destroy();
			let newline;
				while ((newline = input.indexOf("\n")) >= 0) {
				const line = input.slice(0, newline); input = input.slice(newline + 1);
				if (!line) continue;
				let acknowledgement;
				try { acknowledgement = JSON.parse(line); } catch { /* ordinary requests are parsed in #request */ }
				const acknowledgementKey = typeof acknowledgement?.ack === "string"
					? `response:${acknowledgement.ack}`
					: typeof acknowledgement?.confirmAck === "string"
						? `confirmation:${acknowledgement.confirmAck}`
						: undefined;
				if (acknowledgementKey) {
					const pending = acknowledgements.get(acknowledgementKey);
					if (!pending) { socket.destroy(); return; }
					acknowledgements.delete(acknowledgementKey);
					pending.resolve();
					continue;
				}
					if (requests.size >= WORKFLOW_LIMITS.maxBrokerRequestsPerSocket || this.inFlightRequests >= WORKFLOW_LIMITS.maxBrokerRequests) {
						socket.destroy();
						return;
					}
					const controller = new AbortController();
					requests.add(controller);
					this.inFlightRequests += 1;
					void this.#request(socket, line, controller, acknowledgements).finally(() => {
						requests.delete(controller);
						this.inFlightRequests -= 1;
					});
			}
		});
	}

	async #request(socket, line, controller, acknowledgements) {
		let request;
		let grant;
		let responseFailure;
		let responseAccepted;
		let responseCommitted;
		let successAccepted = false;
		try {
			request = JSON.parse(line);
			const token = [...this.tokens.keys()].find((candidate) => equalToken(candidate, request.token));
			if (!token) throw Object.assign(new Error("workflow broker authorization failed"), { code: "BROKER_UNAUTHORIZED" });
			grant = this.tokens.get(token);
			grant.controllers.add(controller);
			if (controller.signal.aborted) throw controller.signal.reason;
			const value = await this.handle(request.method, request.params ?? {}, grant.owner, {
				signal: controller.signal,
				onResponseFailure(callback) {
					if (typeof callback !== "function" || responseFailure) throw new Error("workflow broker response-failure handler is invalid");
					responseFailure = callback;
				},
				onResponseAccepted(callback) {
					if (typeof callback !== "function" || responseAccepted) throw new Error("workflow broker response-acceptance handler is invalid");
					responseAccepted = callback;
				},
				onResponseCommitted(callback) {
					if (typeof callback !== "function" || responseCommitted) throw new Error("workflow broker response-commit handler is invalid");
					responseCommitted = callback;
				},
			});
			if (controller.signal.aborted || this.tokens.get(token) !== grant) throw controller.signal.reason ?? Object.assign(new Error("workflow broker authorization was revoked"), { code: "BROKER_REVOKED" });
			const acknowledgement = randomBytes(16).toString("base64url");
			const response = { id: boundedResponseId(request.id), ok: true, value, ack: acknowledgement };
			if (Buffer.byteLength(JSON.stringify(response), "utf8") > WORKFLOW_LIMITS.maxRpcBytes) {
				throw Object.assign(new Error("workflow broker response is too large; inspect it in /workflows"), { code: "BROKER_RESPONSE_TOO_LARGE" });
			}
			let acknowledgementTimer;
			let resolveAcknowledgement;
			let rejectAcknowledgement;
			const acknowledgementPromise = new Promise((resolve, reject) => {
				resolveAcknowledgement = resolve;
				rejectAcknowledgement = reject;
			});
			acknowledgementTimer = setTimeout(() => {
				acknowledgements.delete(`response:${acknowledgement}`);
				rejectAcknowledgement(Object.assign(new Error("workflow broker response was not acknowledged"), { code: "BROKER_RESPONSE_UNACKNOWLEDGED" }));
			}, 5000);
			acknowledgementTimer.unref?.();
			acknowledgements.set(`response:${acknowledgement}`, {
				resolve: () => { clearTimeout(acknowledgementTimer); resolveAcknowledgement(); },
				reject: (error) => { clearTimeout(acknowledgementTimer); rejectAcknowledgement(error); },
			});
			if (!this.#sendResponse(socket, response)) {
				acknowledgements.delete(`response:${acknowledgement}`);
				clearTimeout(acknowledgementTimer);
				throw Object.assign(new Error("workflow broker could not deliver the successful response"), { code: "BROKER_RESPONSE_UNDELIVERABLE" });
			}
			await acknowledgementPromise;
			if (controller.signal.aborted || this.tokens.get(token) !== grant) throw controller.signal.reason ?? Object.assign(new Error("workflow broker authorization was revoked"), { code: "BROKER_REVOKED" });
			// Acceptance is a non-executing manager transition. It must succeed before
			// confirmation is visible to the bridge; a failed transition therefore
			// yields only the error response and remains safely rollbackable.
			const acceptedResult = responseAccepted?.();
			if (acceptedResult && typeof acceptedResult.then === "function") {
				throw new Error("workflow broker response-acceptance handler must be synchronous");
			}
			const confirmation = { id: boundedResponseId(request.id), ok: true, ackConfirmed: acknowledgement };
			let confirmationTimer;
			let resolveConfirmation;
			let rejectConfirmation;
			const confirmationPromise = new Promise((resolve, reject) => {
				resolveConfirmation = resolve;
				rejectConfirmation = reject;
			});
			confirmationTimer = setTimeout(() => {
				acknowledgements.delete(`confirmation:${acknowledgement}`);
				rejectConfirmation(Object.assign(new Error("workflow broker confirmation was not acknowledged"), { code: "BROKER_CONFIRMATION_UNACKNOWLEDGED" }));
			}, 5000);
			confirmationTimer.unref?.();
			acknowledgements.set(`confirmation:${acknowledgement}`, {
				resolve: () => { clearTimeout(confirmationTimer); resolveConfirmation(); },
				reject: (error) => { clearTimeout(confirmationTimer); rejectConfirmation(error); },
			});
			if (!this.#sendResponse(socket, confirmation)) {
				acknowledgements.delete(`confirmation:${acknowledgement}`);
				clearTimeout(confirmationTimer);
				throw Object.assign(new Error("workflow broker could not confirm response acceptance"), { code: "BROKER_RESPONSE_CONFIRMATION_UNDELIVERABLE" });
			}
			await confirmationPromise;
			if (controller.signal.aborted || this.tokens.get(token) !== grant) throw controller.signal.reason ?? Object.assign(new Error("workflow broker authorization was revoked"), { code: "BROKER_REVOKED" });
			// Commit durably publishes the execution-release marker only after the
			// bridge's final ACK. Do not report success until that asynchronous fsync
			// boundary has completed.
			await responseCommitted?.();
			// The final bridge ACK transfers ownership of the admitted task. From this
			// point a lost committed frame is reconciled by taskId and must never stop
			// an already-started workflow as though it were still unaccepted.
			successAccepted = true;
			if (!this.#sendResponse(socket, { id: boundedResponseId(request.id), ok: true, committed: acknowledgement })) {
				throw Object.assign(new Error("workflow broker could not report the committed launch"), { code: "BROKER_COMMIT_CONFIRMATION_UNDELIVERABLE" });
			}
		} catch (error) {
			if (!successAccepted && responseFailure) {
				try { await responseFailure(); }
				catch (rollbackError) {
					error = new AggregateError([error, rollbackError], "workflow broker response failed and its admitted operation could not be rolled back");
					error.code = "BROKER_RESPONSE_ROLLBACK_FAILED";
				}
			}
			const response = { id: boundedResponseId(request?.id), ok: false, error: { code: error?.code ?? "BROKER_ERROR", message: String(error?.message ?? error).slice(0, 64 * 1024) } };
			this.#sendResponse(socket, response);
		} finally { grant?.controllers.delete(controller); }
	}

	#sendResponse(socket, response) {
		if (socket.destroyed) return false;
		const frame = `${JSON.stringify(response)}\n`;
		const bytes = Buffer.byteLength(frame, "utf8");
		if (bytes > WORKFLOW_LIMITS.maxRpcBytes || socket.writableLength + bytes > WORKFLOW_LIMITS.maxRpcBytes) {
			socket.destroy();
			return false;
		}
		// A peer that stops reading must not turn sequential, already-settled
		// requests into an unbounded host-side write queue.
		const accepted = socket.write(frame);
		if (!accepted) socket.destroy();
		return accepted;
	}

	async stop() {
		const starting = this.startPromise;
		if (starting) await starting.catch(() => {});
		for (const token of [...this.tokens.keys()]) this.revoke(token);
		if (!this.server) return;
		for (const socket of this.sockets) socket.destroy();
		const server = this.server;
		await new Promise((resolve) => {
			try { server.close(() => resolve()); }
			catch { resolve(); }
		});
		this.server = undefined;
		if (process.platform !== "win32" && this.endpoint) await this.unlink(this.endpoint).catch(() => {});
		this.endpoint = undefined;
		if (this.endpointDirectory) await this.rmdir(this.endpointDirectory).catch(() => {});
		this.endpointDirectory = undefined;
		this.failed = false;
	}
}
