import { WORKFLOW_LIMITS } from "./types.mjs";

function abortError(reason = "Operation aborted") {
	if (reason instanceof Error) return reason;
	const error = new Error(String(reason));
	error.name = "AbortError";
	return error;
}

function configuredLimit(value, fallback, maximum, label) {
	if (value === undefined) return fallback;
	if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
		throw new Error(`${label} must be a safe integer from 1 to ${maximum}`);
	}
	return value;
}

export class WorkflowScheduler {
	constructor(options = {}) {
		this.globalLimit = configuredLimit(options.globalLimit, WORKFLOW_LIMITS.globalConcurrency, WORKFLOW_LIMITS.globalConcurrency, "workflow global concurrency");
		this.harnessLimit = configuredLimit(options.harnessLimit, 8, WORKFLOW_LIMITS.globalConcurrency, "workflow per-harness concurrency");
		this.maxPending = configuredLimit(options.maxPending, WORKFLOW_LIMITS.maxPending, WORKFLOW_LIMITS.maxPending, "workflow pending queue limit");
		this.active = 0;
		this.activeByRun = new Map();
		this.activeByHarness = new Map();
		this.runLimits = new Map();
		this.runGates = new Map();
		this.queues = new Map();
		this.runOrder = [];
		this.nextRunIndex = 0;
	}

	configureRun(runId, limit) {
		const requested = configuredLimit(limit, WORKFLOW_LIMITS.defaultRunConcurrency, WORKFLOW_LIMITS.maxRunConcurrency, "workflow run concurrency");
		const effective = Math.min(requested, this.globalLimit);
		this.runLimits.set(runId, effective);
		this.runGates.set(runId, true);
		return effective;
	}

	pause(runId) {
		if (this.runGates.has(runId)) this.runGates.set(runId, false);
	}

	resume(runId) {
		if (this.runGates.has(runId)) this.runGates.set(runId, true);
		this.#drain();
	}

	cancelRun(runId, reason = "Workflow stopped") {
		const queue = this.queues.get(runId) ?? [];
		this.queues.delete(runId);
		this.runOrder = this.runOrder.filter((id) => id !== runId);
		for (const entry of queue) {
			entry.cleanup();
			entry.reject(abortError(reason));
		}
	}

	closeRun(runId) {
		this.cancelRun(runId);
		this.runLimits.delete(runId);
		this.runGates.delete(runId);
	}

	acquire({ runId, harness, signal }) {
		if (!this.runLimits.has(runId)) throw new Error(`Unknown workflow run: ${runId}`);
		if (signal?.aborted) return Promise.reject(abortError(signal.reason));
		const pending = [...this.queues.values()].reduce((total, queue) => total + queue.length, 0);
		if (pending >= this.maxPending) return Promise.reject(new Error("Workflow scheduler queue is full"));
		return new Promise((resolve, reject) => {
			const entry = { runId, harness, resolve, reject, signal, cleanup: () => {} };
			if (signal) {
				const onAbort = () => {
					this.#remove(entry);
					reject(abortError(signal.reason));
				};
				signal.addEventListener("abort", onAbort, { once: true });
				entry.cleanup = () => signal.removeEventListener("abort", onAbort);
			}
			if (!this.queues.has(runId)) {
				this.queues.set(runId, []);
				this.runOrder.push(runId);
			}
			this.queues.get(runId).push(entry);
			this.#drain();
		});
	}

	#remove(entry) {
		const queue = this.queues.get(entry.runId);
		if (!queue) return;
		const index = queue.indexOf(entry);
		if (index >= 0) queue.splice(index, 1);
		if (queue.length === 0) {
			this.queues.delete(entry.runId);
			this.runOrder = this.runOrder.filter((id) => id !== entry.runId);
		}
	}

	#eligible(entry) {
		return this.runGates.get(entry.runId) !== false &&
			(this.activeByRun.get(entry.runId) ?? 0) < (this.runLimits.get(entry.runId) ?? 1) &&
			(this.activeByHarness.get(entry.harness) ?? 0) < this.harnessLimit &&
			this.active < this.globalLimit;
	}

	#drain() {
		while (this.active < this.globalLimit && this.runOrder.length > 0) {
			let picked;
			for (let offset = 0; offset < this.runOrder.length; offset += 1) {
				const index = (this.nextRunIndex + offset) % this.runOrder.length;
				const runId = this.runOrder[index];
				const queue = this.queues.get(runId) ?? [];
				const queueIndex = queue.findIndex((entry) => this.#eligible(entry));
				if (queueIndex >= 0) { picked = { index, queueIndex, entry: queue[queueIndex] }; break; }
			}
			if (!picked) return;
			const { entry } = picked;
			const queue = this.queues.get(entry.runId);
			queue.splice(picked.queueIndex, 1);
			if (queue.length === 0) {
				this.queues.delete(entry.runId);
				this.runOrder.splice(picked.index, 1);
				if (this.runOrder.length === 0) this.nextRunIndex = 0;
				// Removal shifts the immediate successor into the selected slot.
				else this.nextRunIndex = picked.index % this.runOrder.length;
			} else this.nextRunIndex = (picked.index + 1) % this.runOrder.length;
			entry.cleanup();
			this.active += 1;
			this.activeByRun.set(entry.runId, (this.activeByRun.get(entry.runId) ?? 0) + 1);
			this.activeByHarness.set(entry.harness, (this.activeByHarness.get(entry.harness) ?? 0) + 1);
			let released = false;
			entry.resolve(() => {
				if (released) return;
				released = true;
				this.active -= 1;
				this.#decrement(this.activeByRun, entry.runId);
				this.#decrement(this.activeByHarness, entry.harness);
				this.#drain();
			});
		}
	}

	#decrement(map, key) {
		const value = (map.get(key) ?? 1) - 1;
		if (value <= 0) map.delete(key);
		else map.set(key, value);
	}

	snapshot() {
		return Object.freeze({
			active: this.active,
			pending: [...this.queues.values()].reduce((total, queue) => total + queue.length, 0),
			activeByRun: Object.fromEntries(this.activeByRun),
			activeByHarness: Object.fromEntries(this.activeByHarness),
		});
	}
}
