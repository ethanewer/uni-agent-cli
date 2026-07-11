// Harness-neutral checklist state derived from ACP plan notifications.
//
// ACP's stable `plan` update is an unnamed complete snapshot. Newer protocol
// revisions can publish multiple identified item plans through `plan_update`
// and remove them with `plan_removed`. Cursor's update_todos extension is also
// a complete snapshot. The transport normalizes all three into this one bounded
// shape before anything reaches the TUI.

export const CHECKLIST_MAX_PLANS = 32;
export const CHECKLIST_MAX_ENTRIES = 500;
export const CHECKLIST_MAX_CONTENT_CHARS = 2_000;
export const CHECKLIST_MAX_RAW_CONTENT_CHARS = CHECKLIST_MAX_CONTENT_CHARS * 4;

const DEFAULT_PLAN_ID = "default";
const STATUS_ALIASES = Object.freeze({
	completed: "completed",
	complete: "completed",
	done: "completed",
	in_progress: "in_progress",
	"in-progress": "in_progress",
	active: "in_progress",
	running: "in_progress",
	pending: "pending",
	queued: "pending",
});

/** Return a fresh snapshot so callers never share mutable empty state. */
export function emptyChecklistSnapshot() {
	return {
		revision: 0,
		entries: [],
		total: 0,
		completed: 0,
		inProgress: 0,
		pending: 0,
	};
}

/** Normalize a complete list from ACP or a harness extension. */
export function normalizeChecklistEntries(entries, options = {}) {
	if (!Array.isArray(entries)) return [];
	const planId = normalizePlanId(options.planId) ?? DEFAULT_PLAN_ID;
	const limit = Math.min(
		CHECKLIST_MAX_ENTRIES,
		Number.isSafeInteger(options.limit) && options.limit >= 0 ? options.limit : CHECKLIST_MAX_ENTRIES,
	);
	const normalized = [];
	// Inspect at most the advertised output bound. Invalid entries must not turn a
	// bounded snapshot into an unbounded linear scan of hostile adapter input.
	const inspected = Math.min(entries.length, limit);
	for (let index = 0; index < inspected && normalized.length < limit; index += 1) {
		const entry = entries[index];
		if (!entry || typeof entry !== "object") continue;
		const content = normalizeChecklistContent(entry.content ?? entry.subject ?? entry.title ?? entry.description);
		if (!content) continue;
		const status = normalizeChecklistStatus(entry.status);
		const priority = normalizeChecklistPriority(entry.priority);
		const sourceId = normalizeSourceEntryId(entry.id ?? entry.taskId ?? entry.task_id);
		normalized.push({
			id: sourceId ? `${planId}:${sourceId}` : `${planId}:${index}`,
			content,
			status,
			priority,
		});
	}
	return normalized;
}

/**
 * Per-session accumulator. It retains identified ACP plans independently and
 * publishes a single flattened checklist snapshot to the shared interface.
 */
export class ChecklistStore {
	constructor(options = {}) {
		this.maxPlans = options.maxPlans ?? CHECKLIST_MAX_PLANS;
		this.maxEntries = options.maxEntries ?? CHECKLIST_MAX_ENTRIES;
		this.reset();
	}

	reset() {
		this.revision = 0;
		this.plans = new Map();
		this.snapshot = emptyChecklistSnapshot();
		return this.snapshot;
	}

	/** Stable ACP `plan` and extension snapshots replace the unnamed plan. */
	replace(entries, options = {}) {
		this.plans.clear();
		return this.replacePlan(options.planId ?? DEFAULT_PLAN_ID, entries, options);
	}

	/** Replace one complete identified plan and return the flattened snapshot. */
	replacePlan(planId, entries, options = {}) {
		const id = normalizePlanId(planId) ?? DEFAULT_PLAN_ID;
		if (!this.plans.has(id) && this.plans.size >= this.maxPlans) {
			this.plans.delete(this.plans.keys().next().value);
		}
		this.plans.set(id, normalizeChecklistEntries(entries, { ...options, planId: id, limit: this.maxEntries }));
		return this.#publish();
	}

	removePlan(planId) {
		const id = normalizePlanId(planId);
		if (!id || !this.plans.delete(id)) return this.snapshot;
		return this.#publish();
	}

	list() {
		return this.snapshot;
	}

	#publish() {
		const entries = [];
		for (const planEntries of this.plans.values()) {
			for (const entry of planEntries) {
				if (entries.length >= this.maxEntries) break;
				entries.push({ ...entry });
			}
			if (entries.length >= this.maxEntries) break;
		}
		const completed = entries.filter((entry) => entry.status === "completed").length;
		const inProgress = entries.filter((entry) => entry.status === "in_progress").length;
		this.snapshot = Object.freeze({
			revision: ++this.revision,
			entries: Object.freeze(entries.map((entry) => Object.freeze(entry))),
			total: entries.length,
			completed,
			inProgress,
			pending: entries.length - completed - inProgress,
		});
		return this.snapshot;
	}
}

export function formatChecklistSnapshot(snapshot = emptyChecklistSnapshot()) {
	const entries = Array.isArray(snapshot?.entries) ? snapshot.entries : [];
	if (entries.length === 0) return "No checklist is available for this session yet.";
	const completed = Number.isSafeInteger(snapshot.completed)
		? snapshot.completed
		: entries.filter((entry) => entry?.status === "completed").length;
	const lines = [`Checklist · ${completed}/${entries.length} complete`];
	for (const entry of entries) lines.push(`${checklistGlyph(entry?.status)} ${normalizeChecklistContent(entry?.content)}`);
	return lines.join("\n");
}

export function checklistGlyph(status) {
	if (status === "completed") return "[x]";
	if (status === "in_progress") return "[>]";
	return "[ ]";
}

function normalizeChecklistStatus(value) {
	return STATUS_ALIASES[String(value ?? "pending").toLowerCase()] ?? "pending";
}

function normalizeChecklistPriority(value) {
	const priority = String(value ?? "medium").toLowerCase();
	return ["high", "medium", "low"].includes(priority) ? priority : "medium";
}

function normalizeChecklistContent(value) {
	if (typeof value !== "string") return "";
	return value.slice(0, CHECKLIST_MAX_RAW_CONTENT_CHARS)
		.replace(/[\r\n\t\f\v]+/gu, " ")
		.replace(/[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu, "")
		.replace(/\s+/gu, " ")
		.trim()
		.slice(0, CHECKLIST_MAX_CONTENT_CHARS);
}

function normalizePlanId(value) {
	if (typeof value !== "string") return undefined;
	const id = value.slice(0, 1_024).trim().replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 256);
	return id || undefined;
}

function normalizeSourceEntryId(value) {
	if (typeof value !== "string" && typeof value !== "number") return undefined;
	const id = String(value).slice(0, 1_024).trim().replace(/[\u0000-\u001f\u007f-\u009f]/gu, "").slice(0, 256);
	return id || undefined;
}
