import { matchesKey } from "@mariozechner/pi-tui/dist/keys.js";
import { truncateToWidth, wrapTextWithAnsi } from "@mariozechner/pi-tui/dist/utils.js";
import { sanitizeUntrustedTerminalLine, sanitizeUntrustedTerminalText } from "../harness/terminal-safety.mjs";

const ansi = {
	reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", blue: "\x1b[34m", cyan: "\x1b[36m",
	green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", inverse: "\x1b[7m",
};
let themedPainter;
export function configureWorkflowStyles(painter) { themedPainter = typeof painter === "function" ? painter : undefined; }
const paint = (style, value) => themedPainter?.(style, String(value)) ?? `${ansi[style]}${value}${ansi.reset}`;

function icon(status) {
	if (status === "completed") return paint("green", "✓");
	if (["failed", "stopped", "interrupted"].includes(status)) return paint("red", status === "failed" ? "✗" : "■");
	if (status === "paused") return paint("yellow", "Ⅱ");
	if (["running", "restarting", "stopping"].includes(status)) return paint("cyan", "●");
	return paint("dim", "○");
}

function elapsed(start, end) {
	if (!start) return "";
	const seconds = Math.max(0, Math.floor((new Date(end ?? Date.now()).getTime() - new Date(start).getTime()) / 1000));
	if (seconds < 60) return `${seconds}s`;
	if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
	return `${Math.floor(seconds / 3600)}h ${Math.floor((seconds % 3600) / 60)}m`;
}

function line(value, width) { return truncateToWidth(String(value), Math.max(1, width)); }
function wrapped(value, width) { return wrapTextWithAnsi(String(value), Math.max(1, width)); }
const safe = (value) => sanitizeUntrustedTerminalText(value);
const safeLine = (value) => sanitizeUntrustedTerminalLine(value);

function compactBlockedExitNotice(width) {
	if (width >= 29) return "Ctrl-D ×2 within 2s: force exit";
	if (width >= 20) return "Ctrl-D ×2 ≤2s: exit";
	if (width >= 14) return "Ctrl-D ×2 ≤2s";
	if (width >= 8) return "^D×2 ≤2s";
	return "^D×2";
}

function compactExitNotice(width) {
	if (width >= 18) return "Ctrl-D: exit";
	if (width >= 8) return "^D: exit";
	if (width >= 4) return "^D→";
	return "D";
}

function usageText(usage, quality) {
	if (quality === "unknown") return "usage unknown";
	if (!usage || typeof usage !== "object") return quality === "estimated" ? "~usage unavailable" : undefined;
	const prefix = quality === "estimated" ? "~" : "";
	for (const key of ["totalTokens", "total_tokens"]) {
		if (Number.isFinite(Number(usage[key]))) return `${prefix}${Math.max(0, Math.trunc(Number(usage[key])))} tokens`;
	}
	const values = [];
	for (const [label, keys] of [
		["input", ["inputTokens", "input_tokens"]],
		["output", ["outputTokens", "output_tokens"]],
		["cache", ["cachedTokens", "cached_tokens"]],
	]) {
		const key = keys.find((candidate) => Number.isFinite(Number(usage[candidate])));
		if (key) values.push(`${label} ${Math.max(0, Math.trunc(Number(usage[key])))}`);
	}
	return values.length > 0 ? `${prefix}${values.join(" · ")} tokens` : `${prefix}reported (details unavailable)`;
}

export class WorkflowTaskSummary {
	constructor(getRuns) { this.getRuns = getRuns; }
	invalidate() {}
	activeRuns() { return this.getRuns().filter((run) => ["pending", "running", "paused", "stopping"].includes(run.status)); }
	render(width) {
		const runs = this.activeRuns();
		if (runs.length === 0) return [];
		const rows = [line(paint("bold", ` Dynamic workflows (${runs.length})`), width)];
		for (const run of runs.slice(0, 4)) {
			const done = run.agents.filter((agent) => agent.status === "completed").length;
			const active = run.agents.filter((agent) => ["running", "restarting"].includes(agent.status)).length;
			rows.push(line(` ${icon(run.status)} ${safeLine(run.name)}  ${safeLine(run.status)} · ${done}/${run.agents.length} done${active ? ` · ${active} active` : ""} · ${elapsed(run.startedAt)}`, width));
		}
		if (runs.length > 4) rows.push(line(paint("dim", `   +${runs.length - 4} more`), width));
		rows.push(line(paint("dim", "   Enter or /workflows to inspect · workflows continue in the background"), width));
		return rows;
	}
}

export class WorkflowPage {
	constructor({ manager, onClose, onChange, onNotice, onApply, onRecover, onSave }) {
		this.manager = manager;
		this.onClose = onClose;
		this.onChange = onChange ?? (() => {});
		const notice = onNotice ?? (() => {});
		this.onNotice = (message) => { this.showNotice(message); notice(safe(message)); };
		this.onApply = onApply ?? (() => {});
		this.onRecover = onRecover ?? (() => {});
		this.onSave = onSave ?? (() => {});
		this.recoveringRuns = new Set();
		this.level = "runs";
		this.runIndex = 0;
		this.runId = undefined;
		this.phaseIndex = 0;
		this.phaseName = undefined;
		this.agentIndex = 0;
		this.agentId = undefined;
		this.attemptIndex = 0;
		this.attemptNumber = undefined;
		this.scroll = 0;
		this.focused = true;
		this.selectionGeneration = 0;
	}

	invalidate() {
		if (this.level !== "apply-preview" || !this.applyPreview) return;
		this.applyPreview.disclosedIdentityRows = new Set();
		this.applyPreviewDisclosed = false;
		this.applyPreviewNeedsResize = true;
	}

	showNotice(message, options = {}) {
		this.notice = safe(message);
		this.noticeKind = options.kind ?? (/Ctrl-D.*exit/iu.test(this.notice) ? "exit-hint" : undefined);
		this.onChange();
	}

	showApplyPreview(preview, onConfirm) {
		this.applyPreview = { ...preview, onConfirm, disclosedIdentityRows: new Set(), disclosureWidth: undefined };
		this.applyPreviewDisclosed = false;
		this.previousLevel = this.level;
		this.previousScroll = this.scroll;
		this.level = "apply-preview";
		this.scroll = 0;
		this.onChange();
	}

	selectedRun() {
		const runs = this.manager.list();
		if (this.runId !== undefined) {
			const index = runs.findIndex((run) => run.id === this.runId);
			if (index < 0) return undefined;
			this.runIndex = index;
			return runs[index];
		}
		const run = runs[this.runIndex];
		this.runId = run?.id;
		return run;
	}
	phases() {
		const run = this.selectedRun();
		if (!run) return [];
		return [...new Set([...(run.phases ?? []), ...run.agents.map((agent) => agent.phase).filter(Boolean), "Unphased"])].filter((phase) => phase !== "Unphased" || run.agents.some((agent) => !agent.phase));
	}
	selectedPhase() {
		const phases = this.phases();
		if (this.phaseName !== undefined) {
			const index = phases.indexOf(this.phaseName);
			if (index < 0) return undefined;
			this.phaseIndex = index;
			return phases[index];
		}
		const phase = phases[this.phaseIndex];
		this.phaseName = phase;
		return phase;
	}
	phaseAgents() {
		const run = this.selectedRun();
		const phase = this.selectedPhase();
		return run?.agents.filter((agent) => phase === "Unphased" ? !agent.phase : agent.phase === phase) ?? [];
	}
	selectedAgent() {
		const agents = this.phaseAgents();
		if (this.agentId !== undefined) {
			const index = agents.findIndex((agent) => agent.id === this.agentId);
			if (index < 0) return undefined;
			this.agentIndex = index;
			return agents[index];
		}
		const agent = agents[this.agentIndex];
		this.agentId = agent?.id;
		return agent;
	}
	attempts() {
		const agent = this.selectedAgent();
		return agent?.attempts ?? [];
	}
	selectedAttempt() {
		const attempts = this.attempts();
		if (this.attemptNumber !== undefined) {
			const index = attempts.findIndex((attempt) => attempt.number === this.attemptNumber);
			if (index < 0) return undefined;
			this.attemptIndex = index;
			return attempts[index];
		}
		const attempt = attempts[this.attemptIndex];
		this.attemptNumber = attempt?.number;
		return attempt;
	}

	#selectRun(index, runs = this.manager.list()) {
		this.selectionGeneration += 1;
		this.runIndex = Math.max(0, Math.min(Math.max(0, runs.length - 1), index));
		// Run rows contain a summary, detail, and spacer line.
		this.scroll = this.runIndex * 3;
		this.runId = runs[this.runIndex]?.id;
		this.phaseName = undefined; this.agentId = undefined; this.attemptNumber = undefined;
	}

	#selectPhase(index, phases = this.phases()) {
		this.selectionGeneration += 1;
		this.phaseIndex = Math.max(0, Math.min(Math.max(0, phases.length - 1), index));
		this.scroll = this.phaseIndex;
		this.phaseName = phases[this.phaseIndex];
		this.agentId = undefined; this.attemptNumber = undefined;
	}

	#selectAgent(index, agents = this.phaseAgents()) {
		this.selectionGeneration += 1;
		this.agentIndex = Math.max(0, Math.min(Math.max(0, agents.length - 1), index));
		this.scroll = this.agentIndex;
		this.agentId = agents[this.agentIndex]?.id;
		this.attemptNumber = undefined;
	}

	#selectAttempt(index, attempts = this.attempts()) {
		this.selectionGeneration += 1;
		this.attemptIndex = Math.max(0, Math.min(Math.max(0, attempts.length - 1), index));
		this.scroll = this.attemptIndex;
		this.attemptNumber = attempts[this.attemptIndex]?.number;
	}

	#restoreSelectionScroll() {
		if (this.level === "runs") this.scroll = this.runIndex * 3;
		else if (this.level === "phases") this.scroll = this.phaseIndex;
		else if (this.level === "agents") this.scroll = this.agentIndex;
		else if (this.level === "attempts") this.scroll = this.attemptIndex;
		else this.scroll = 0;
	}

	handleInput(data) {
		if (this.level === "apply-preview" && data === "a") {
			if (this.applyPreview?.pending) return true;
			const preview = this.applyPreview;
			if (preview.patchTruncated || preview.changedFilesTruncated) {
				this.onNotice(preview.patchTruncated
					? "This patch exceeds the interactive preview limit and cannot be applied from cc; inspect and apply it manually from the retained worktree."
					: "The changed-file summary exceeds the interactive disclosure limit and cannot be applied from cc; inspect and apply it manually from the retained worktree.");
				return true;
			}
			if (!this.applyPreviewDisclosed) {
				this.onNotice(this.applyPreviewNeedsResize
					? "Resize the terminal to inspect the changed-file summary before applying this worktree."
					: "Scroll with j/k until every target and changed-file identity has been displayed before applying this worktree.");
				return true;
			}
			preview.pending = true;
			this.onChange();
			void Promise.resolve(preview.onConfirm?.()).then(() => {
				if (this.applyPreview === preview) {
					this.level = this.previousLevel ?? "attempts";
					this.applyPreview = undefined;
					this.scroll = this.previousScroll ?? 0;
				}
				this.onChange();
			}, (error) => {
				preview.pending = false;
				this.onNotice(`Could not apply worktree: ${error.message ?? error}`);
				this.onChange();
			});
			return true;
		}
		if (
			this.level === "apply-preview" &&
			!["j", "k", "q"].includes(data) &&
			!["escape", "left", "up", "down"].some((key) => matchesKey(data, key))
		) return true;
		const rows = this.level === "runs" ? this.manager.list()
			: this.level === "phases" ? this.phases()
				: this.level === "agents" ? this.phaseAgents() : this.level === "attempts" ? this.attempts() : [];
		if (matchesKey(data, "escape") || matchesKey(data, "left") || data === "q") {
			let restoreInspectionScroll = false;
			if (this.level === "apply-preview") { this.level = this.previousLevel ?? "attempts"; this.applyPreview = undefined; restoreInspectionScroll = true; }
			else if (this.level === "detail") this.level = "attempts";
			else if (this.level === "run-detail") this.level = "runs";
			else if (this.level === "script") { this.level = this.previousLevel ?? "runs"; restoreInspectionScroll = true; }
			else if (this.level === "attempts") this.level = "agents";
			else if (this.level === "agents") this.level = "phases";
			else if (this.level === "phases") this.level = "runs";
			else this.onClose();
			if (restoreInspectionScroll) this.scroll = this.previousScroll ?? 0;
			else this.#restoreSelectionScroll();
			this.onChange(); return true;
		}
		if (matchesKey(data, "up") || data === "k") {
			if (this.level === "runs") { this.selectedRun(); this.#selectRun(this.runIndex - 1, rows); }
			else if (this.level === "phases") { this.selectedPhase(); this.#selectPhase(this.phaseIndex - 1, rows); }
			else if (this.level === "agents") { this.selectedAgent(); this.#selectAgent(this.agentIndex - 1, rows); }
			else if (this.level === "attempts") { this.selectedAttempt(); this.#selectAttempt(this.attemptIndex - 1, rows); }
			else this.scroll = Math.max(0, this.scroll - 1);
			this.onChange(); return true;
		}
		if (matchesKey(data, "down") || data === "j") {
			if (this.level === "runs") { this.selectedRun(); this.#selectRun(this.runIndex + 1, rows); }
			else if (this.level === "phases") { this.selectedPhase(); this.#selectPhase(this.phaseIndex + 1, rows); }
			else if (this.level === "agents") { this.selectedAgent(); this.#selectAgent(this.agentIndex + 1, rows); }
			else if (this.level === "attempts") { this.selectedAttempt(); this.#selectAttempt(this.attemptIndex + 1, rows); }
			else this.scroll += 1;
			this.onChange(); return true;
		}
		if (matchesKey(data, "enter") || matchesKey(data, "right")) {
			const previousLevel = this.level;
			if (this.level === "runs" && this.selectedRun()) { this.level = "phases"; this.#selectPhase(0); }
			else if (this.level === "phases" && this.selectedPhase()) { this.level = "agents"; this.#selectAgent(0); }
			else if (this.level === "agents" && this.selectedAgent()) { this.level = "attempts"; this.#selectAttempt(Math.max(0, this.attempts().length - 1)); }
			else if (this.level === "attempts" && this.selectedAttempt()) this.level = "detail";
			if (this.level !== previousLevel) this.scroll = 0;
			this.onChange(); return true;
		}
		const run = this.selectedRun();
		if (!run) return false;
		if (data === "v" && ["runs", "phases", "agents", "attempts", "detail"].includes(this.level)) {
			if (this.level !== "script") { this.selectionGeneration += 1; this.previousLevel = this.level; this.previousScroll = this.scroll; this.level = "script"; this.scroll = 0; }
			this.onChange(); return true;
		}
		if (data === "d" && this.level === "runs") { this.selectionGeneration += 1; this.level = "run-detail"; this.scroll = 0; this.onChange(); return true; }
		if (data === "c" && this.level === "runs") {
			if (run.status !== "interrupted") this.onNotice("Only an interrupted persisted workflow can be recovered");
			else if (this.recoveringRuns.has(run.id)) this.onNotice("Recovery approval is already pending for this workflow");
			else {
				const recoverySelectionGeneration = this.selectionGeneration;
				const recoveryRunId = run.id;
				this.recoveringRuns.add(run.id);
				this.onChange();
				void Promise.resolve(this.onRecover(run)).then((started) => {
					const newId = started?.taskId;
					if (newId) {
						const runs = this.manager.list();
						const index = runs.findIndex((candidate) => candidate.id === newId);
						if (index >= 0 && this.selectionGeneration === recoverySelectionGeneration && this.selectedRun()?.id === recoveryRunId) {
							this.#selectRun(index, runs);
						}
						this.onNotice(`Started recovery ${String(newId).slice(0, 8)}`);
					}
				}, (error) => this.onNotice(`Could not recover workflow: ${error.message ?? error}`)).finally(() => {
					this.recoveringRuns.delete(run.id);
					this.onChange();
				});
			}
			return true;
		}
		if (data === "p" && ["runs", "phases", "agents"].includes(this.level)) {
			if (!["running", "paused"].includes(run.status)) this.onNotice(`A ${run.status} workflow cannot be paused or resumed`);
			else this.#control(() => this.manager.status(run.id, run.status === "paused" ? "resume" : "pause"));
			this.onChange(); return true;
		}
		if (data === "x") {
			if (["run-detail", "script"].includes(this.level)) return true;
			const changed = ["runs", "phases"].includes(this.level)
				? this.#control(() => this.manager.stop(run.id))
				: this.#control(() => this.manager.stopAgent(run.id, this.selectedAgent()?.id));
			if (!changed) this.onNotice("The selected workflow task is no longer stoppable");
			this.onChange(); return true;
		}
		if (data === "r" && ["agents", "attempts", "detail"].includes(this.level)) {
			if (!this.#control(() => this.manager.restartAgent(run.id, this.selectedAgent()?.id))) this.onNotice("The selected agent is no longer restartable");
			this.onChange(); return true;
		}
		if (data === "s" && this.level === "runs") {
			void Promise.resolve(this.onSave(run)).catch((error) => this.onNotice(`Could not save workflow: ${error.message ?? error}`));
			return true;
		}
		if (data === "a" && ["agents", "attempts", "detail"].includes(this.level)) {
			const agent = this.selectedAgent();
			const attempt = this.level === "agents" ? this.attempts().at(-1) : this.selectedAttempt();
			if (attempt?.worktree?.retained && !attempt.worktree.appliedAt) {
				void Promise.resolve(this.onApply(run, agent, attempt)).catch((error) => this.onNotice(`Could not apply worktree: ${error.message ?? error}`));
			}
			else this.onNotice("The selected agent has no unapplied retained worktree changes");
			return true;
		}
		return false;
	}

	#control(operation) {
		try {
			const result = operation();
			if (result && typeof result.then === "function") {
				void result.then(() => this.onChange(), (error) => { this.onNotice(error.message ?? String(error)); this.onChange(); });
				return true;
			}
			return result;
		}
		catch (error) { this.onNotice(error.message ?? String(error)); return false; }
	}

	render(width, height = 24) {
		const body = this.level === "runs" ? this.#renderRuns(width)
			: this.level === "phases" ? this.#renderPhases(width)
				: this.level === "agents" ? this.#renderAgents(width)
					: this.level === "attempts" ? this.#renderAttempts(width)
							: this.level === "script" ? this.#renderScript(width) : this.level === "run-detail" ? this.#renderRunDetail(width) : this.level === "apply-preview" ? this.#renderApplyPreview(width) : this.#renderDetail(width);
		const header = line(`${paint("bold", "cc workflows")}  ${paint("dim", this.level === "runs" ? "runs" : `${safeLine(this.selectedRun()?.name ?? "run")} / ${this.level}`)}`, width);
		const noticeText = this.noticeKind === "blocked-exit" ? compactBlockedExitNotice(width)
			: this.noticeKind === "exit-hint" ? compactExitNotice(width) : ` Notice: ${this.notice ?? ""}`;
		if (this.notice && height > 0 && height <= 3) {
			const priorityNotice = wrapped(noticeText, width).map((row) => paint("yellow", row));
			return [...priorityNotice, header].slice(0, Math.floor(height));
		}
		const noticeCapacity = Math.max(0, Math.min(3, height - 3));
		const noticeRows = this.notice && noticeCapacity > 0 ? wrapped(noticeText, width).slice(0, noticeCapacity)
			.map((row) => paint("yellow", row)) : [];
		const viewport = Math.max(0, height - 3 - noticeRows.length);
		if (this.level === "runs" && viewport > 0 && body.length > 0) {
			const selectedStart = this.runIndex * 3;
			const selectedEnd = Math.min(body.length - 1, selectedStart + (viewport > 1 ? 1 : 0));
			if (selectedStart < this.scroll) this.scroll = selectedStart;
			else if (selectedEnd >= this.scroll + viewport) this.scroll = Math.max(0, selectedEnd - viewport + 1);
		}
		const maximum = Math.max(0, body.length - viewport);
		this.scroll = Math.min(this.scroll, maximum);
		if (this.level === "apply-preview" && this.applyPreview) {
			this.applyPreviewNeedsResize = width < 20;
			if (this.applyPreview.disclosureWidth !== width) {
				this.applyPreview.disclosureWidth = width;
				this.applyPreview.disclosedIdentityRows = new Set();
			}
			if (width >= 20) {
				const visibleEnd = this.scroll + viewport;
				for (const index of this.applyPreviewIdentityRows ?? []) {
					if (index >= this.scroll && index < visibleEnd) this.applyPreview.disclosedIdentityRows.add(index);
				}
			}
			this.applyPreviewDisclosed = (this.applyPreviewIdentityRows ?? [])
				.every((index) => this.applyPreview.disclosedIdentityRows.has(index));
		}
		const pauseAction = this.selectedRun()?.status === "paused" ? "resume" : "pause";
		const dashboardHelp = this.level === "apply-preview"
			? this.applyPreview?.patchTruncated || this.applyPreview?.changedFilesTruncated ? "↑↓/j/k scroll · apply disabled · esc cancel"
				: !this.applyPreviewDisclosed ? this.applyPreviewNeedsResize
					? "resize to inspect changes · apply disabled · esc cancel"
					: "↑↓/j/k inspect all identities · apply disabled · esc cancel"
					: "↑↓/j/k scroll · a confirm apply · esc cancel"
			: this.level === "run-detail" ? "↑↓/j/k scroll · esc back"
			: this.level === "script" ? "↑↓/j/k scroll · esc back"
			: this.level === "runs"
			? `↑↓ select · enter phases · d result · p ${pauseAction} · x stop · c recover · v source · s save · esc close`
			: this.level === "phases" ? `↑↓ select · enter agents · p ${pauseAction} · x stop · v source · esc back`
				: this.level === "agents" ? `↑↓ select · enter attempts · a apply latest · r restart · x stop · p ${pauseAction} · v source · esc back`
					: this.level === "attempts" ? "↑↓ select · enter detail · a apply · r restart · x stop · v source · esc back"
					: "↑↓/j/k scroll · a apply · r restart · x stop · v source · esc back";
		const helpText = this.level === "apply-preview"
			? dashboardHelp
			: this.focused ? `${dashboardHelp} · tab composer` : "composer focused · tab dashboard";
		const help = line(paint("dim", helpText), width);
		const visible = body.slice(this.scroll, this.scroll + viewport);
		while (visible.length < viewport) visible.push("");
		return [header, line("─".repeat(Math.max(1, width)), width), ...noticeRows, ...visible, help]
			.slice(0, Math.max(0, Math.floor(height)));
	}

	#renderRuns(width) {
		const runs = this.manager.list();
		if (runs.length === 0) return ["", line(paint("dim", "  No workflows yet. Run /workflow <name>."), width)];
		const selectedRun = this.selectedRun();
		return runs.flatMap((run, index) => {
			const selected = run.id === selectedRun?.id;
			const completed = run.agents.filter((agent) => agent.status === "completed").length;
			const usage = run.usage?.quality === "unknown"
				? " · usage unknown"
				: run.usage?.quality ? ` · ${run.usage.quality === "estimated" ? "~" : ""}${run.usage.tokens} tokens` : "";
			const row = ` ${selected ? "›" : " "} ${icon(run.status)} ${safeLine(run.name)}  ${paint("dim", `${safeLine(run.status)} · ${completed}/${run.agents.length} agents · ${elapsed(run.startedAt, run.finishedAt)}${usage}`)}`;
			const delivery = run.delivery?.state && !["not-ready", "pending", "delivered"].includes(run.delivery.state) ? ` · delivery ${safeLine(run.delivery.state)}` : "";
			const phase = `     ${run.currentPhase ? `${safeLine(run.currentPhase)} · ` : ""}${safeLine(run.description)}${delivery}${run.recoveryOf ? ` · recovery of ${safeLine(run.recoveryOf).slice(0, 8)}` : ""}`;
			return [line(selected ? paint("inverse", row) : row, width), line(paint("dim", phase), width), ""];
		});
	}

	#renderAgents(width) {
		const run = this.selectedRun();
		if (!run) return [line(paint("dim", "Run is no longer available"), width)];
		const agents = this.phaseAgents();
		if (agents.length === 0) return ["", line(paint("dim", "  This phase has no agents yet…"), width)];
		const result = [];
		agents.forEach((agent, index) => {
			const selected = agent.id === this.selectedAgent()?.id;
			const model = agent.model?.id ?? agent.model ?? "default";
			const effort = agent.effort?.id ?? agent.effort;
			const attempt = agent.attempt > 0 ? `attempt ${agent.attempt}` : "not started";
			const row = ` ${selected ? "›" : " "} ${icon(agent.status)} ${safeLine(agent.label)}  ${paint("dim", `${safeLine(agent.status)} · ${safeLine(agent.harness)}/${safeLine(model)}${effort ? `/${safeLine(effort)}` : ""} · ${attempt} · ${elapsed(agent.startedAt, agent.finishedAt)}`)}`;
			result.push(line(selected ? paint("inverse", row) : row, width));
		});
		return result;
	}

	#renderPhases(width) {
		const run = this.selectedRun();
		if (!run) return [line(paint("dim", "Run is no longer available"), width)];
		return this.phases().map((phase, index) => {
			const agents = run.agents.filter((agent) => phase === "Unphased" ? !agent.phase : agent.phase === phase);
			const done = agents.filter((agent) => agent.status === "completed").length;
			const selected = phase === this.selectedPhase();
			const row = ` ${selected ? "›" : " "} ${safeLine(phase)}  ${paint("dim", `${done}/${agents.length} agents complete`)}`;
			return line(selected ? paint("inverse", row) : row, width);
		});
	}

	#renderAttempts(width) {
		const attempts = this.attempts();
		if (attempts.length === 0) return [line(paint("dim", "No attempts have started"), width)];
		return attempts.map((attempt, index) => {
			const selected = attempt.number === this.selectedAttempt()?.number;
			const model = attempt.model?.id ?? attempt.model ?? "default";
			const effort = attempt.effort?.id ?? attempt.effort;
			const retained = attempt.worktree?.retained ? " · retained worktree" : "";
			const row = ` ${selected ? "›" : " "} ${icon(attempt.status)} Attempt ${attempt.number}  ${paint("dim", `${safeLine(attempt.status)} · ${safeLine(model)}${effort ? `/${safeLine(effort)}` : ""} · ${elapsed(attempt.startedAt, attempt.finishedAt)}${retained}`)}`;
			return line(selected ? paint("inverse", row) : row, width);
		});
	}

	#renderScript(width) {
		const source = this.manager.getSource(this.selectedRun()?.id);
		if (!source) return wrapped(" Source is unavailable for this archived workflow", width).map((row) => paint("dim", row));
		return [line(paint("bold", " Approved source"), width), "", ...String(source).split("\n").flatMap((part) => wrapped(`  ${safeLine(part)}`, width))];
	}

	#renderRunDetail(width) {
		const run = this.selectedRun();
		if (!run) return [line(paint("dim", "Run is no longer available"), width)];
		const rows = [
			line(paint("bold", " Run outcome"), width),
			line(paint("dim", ` ${safeLine(run.status)} · delivery ${safeLine(run.delivery?.state ?? "unknown")}`), width),
		];
		if (Object.hasOwn(run, "result") && run.result !== undefined) {
			let rendered;
			try { rendered = typeof run.result === "string" ? run.result : JSON.stringify(run.result, null, 2); }
			catch { rendered = String(run.result); }
			rows.push("", line(paint("bold", " Result"), width), ...String(rendered).split("\n").flatMap((part) => wrapped(`  ${safeLine(part)}`, width)));
		}
		if (run.error) {
			const identity = [run.error.name, run.error.code].filter(Boolean).map(safeLine).join(" · ");
			rows.push("", ...wrapped(` Error${identity ? ` (${identity})` : ""}`, width).map((row) => paint("red", row)), ...String(run.error.message ?? run.error).split("\n").flatMap((part) => wrapped(`  ${safeLine(part)}`, width)));
		}
		if (run.delivery?.message) rows.push("", line(paint("bold", " Delivery"), width), ...wrapped(`  ${safeLine(run.delivery.message)}`, width));
		if (run.result === undefined && !run.error) rows.push("", ...wrapped(" No terminal result is available yet", width).map((row) => paint("dim", row)));
		return rows;
	}

	#renderApplyPreview(width) {
		const preview = this.applyPreview;
		if (!preview) return [line(paint("dim", "Apply preview is unavailable"), width)];
		const targetRows = wrapped(` Target ${safeLine(preview.target.branch)}@${safeLine(preview.target.head)} · ${preview.bytes} patch bytes`, width).map((row) => paint("dim", row));
		const changedRows = preview.changedFiles?.length
			? preview.changedFiles.flatMap((file) => wrapped(`  ${safeLine(file)}`, width))
			: wrapped("  No changed-file summary", width).map((row) => paint("dim", row));
		const truncatedRows = preview.patchTruncated || preview.changedFilesTruncated
			? wrapped(preview.patchTruncated
				? " Patch exceeds the interactive preview limit; apply is disabled. Inspect the retained worktree manually."
				: " Changed-file summary exceeds the interactive disclosure limit; apply is disabled. Inspect the retained worktree manually.", width).map((row) => paint("red", row))
			: [];
		const changedHeadingIndex = 1 + targetRows.length + truncatedRows.length + 1;
		this.applyPreviewIdentityRows = [
			...targetRows.map((_, index) => 1 + index),
			changedHeadingIndex,
			...changedRows.map((_, index) => changedHeadingIndex + 1 + index),
		];
		const rows = [
			line(paint("bold", " Worktree apply preview"), width),
			...targetRows,
			...truncatedRows,
			"", line(paint("bold", " Changed files"), width),
			...changedRows,
			"", line(paint("bold", " Patch"), width),
			...String(preview.patch).split("\n").flatMap((part) => wrapped(`  ${safeLine(part)}`, width)),
		];
		return rows;
	}

	#renderDetail(width) {
		const agent = this.selectedAgent();
		if (!agent) return [line(paint("dim", "Agent is no longer available"), width)];
		const attempt = this.selectedAttempt();
		if (!attempt) return [line(paint("dim", "Attempt is no longer available"), width)];
		const model = attempt.model?.id ?? attempt.model ?? "configured default";
		const effort = attempt.effort?.id ?? attempt.effort;
		const usage = usageText(attempt.usage, attempt.usageQuality);
		const rows = [
			line(` ${icon(attempt.status)} ${paint("bold", safeLine(agent.label))} · ${safeLine(attempt.status)}`, width),
			line(paint("dim", ` ${safeLine(agent.harness)}/${safeLine(model)}${effort ? `/${safeLine(effort)}` : ""} · attempt ${attempt.number} · ${elapsed(attempt.startedAt, attempt.finishedAt)}${usage ? ` · ${usage}` : ""}`), width),
			"", line(paint("bold", " Prompt"), width), ...String(agent.prompt).split("\n").flatMap((part) => wrapped(`  ${safeLine(part)}`, width)),
		];
		if (attempt.tools?.length) rows.push("", line(paint("bold", " Tool activity"), width), ...attempt.tools.slice(-20).map((tool) => line(`  ${icon(tool.status)} ${safeLine(tool.title ?? tool.id ?? "tool")}`, width)));
		if (attempt.output) rows.push("", line(paint("bold", " Output"), width), ...String(attempt.output).split("\n").slice(-200).flatMap((part) => wrapped(`  ${safeLine(part)}`, width)));
		if (attempt.error) {
			const identity = [attempt.error.name, attempt.error.code].filter(Boolean).map(safeLine).join(" · ");
			rows.push("", ...wrapped(paint("red", ` Error${identity ? ` (${identity})` : ""}: ${safeLine(attempt.error.message ?? attempt.error)}`), width));
		}
		if (attempt.worktree) {
			const state = attempt.worktree.appliedAt ? "applied" : attempt.worktree.retained ? "retained · press a to preview/apply" : "cleaned up";
			rows.push("", line(paint("bold", " Worktree"), width), ...wrapped(`  ${safeLine(attempt.worktree.directory)} (${state})`, width));
			if (attempt.worktree.changedFiles?.length) rows.push(...attempt.worktree.changedFiles.slice(0, 100).map((file) => line(`  ${safeLine(file)}`, width)));
		}
		return rows;
	}
}
