/**
 * Reset tool - discard this context and continue the work from the memory file.
 *
 * Continuity lives outside the conversation: the model keeps the memory file current while it
 * works, so a reset never has to generate a long handover text in one tool argument - the place
 * where a local model closes the string early and the continuation inherits a half-note.
 * Nothing checks the memory file; a reset with a thin memory file simply continues thin.
 *
 * The 80% context warning exists because a local model that runs out of context mid-task loses the
 * task: it never thinks to hand over by itself. One warning, not the three-stage ladder the LLE mod
 * uses - a strong model needs telling once.
 *
 * The memory file is memory.md in the project root, so every project keeps its own record and a
 * reset from any of its subdirectories still lands on it. Only what cannot be re-derived belongs in
 * it: a file that duplicates the source is a second, staler copy of the source.
 */

import {
	defineTool,
	type BoundaryResult,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomInt } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const MEMORY_BASENAME = "memory.md";
const INLINE_LIMIT = 12000;
const WARN_PERCENT = 80;

/** What a cold resume needs from the memory file; shared by the refusal text and the context warning. */
const MEMORY_CHECKLIST =
	"the task in the words it was given, the constraints that still hold, what is done and verified, where the work stands, the next steps, the file paths that matter, and any process still running";

/** Where the file sits, in the words a model sees before any call hands it the resolved path. */
const MEMORY_LOCATION =
	"the project root directory (the nearest ancestor holding .git, or the working directory when none does)";

/** Selection and density rule; shared by the tool description, the context warning and the refusal. */
const MEMORY_RULE =
	"Only what cannot be re-derived belongs there: what the source code does not say and a couple of web queries will not return - decisions and why they were taken, constraints, gotchas, dead ends, the state of the work. Write compact lines, not prose.";

/** Set by an armed reset call, consumed by the next turn_end. */
let armed = false;

/** Set when the warning is emitted, cleared when usage falls back under the threshold. */
let contextWarned = false;

/**
 * One-time code, not a fixed word: to pass, the model has to copy digits that are in the tool
 * result directly above it, so an invented or remembered confirmation cannot carry a reset.
 */
let pendingPin: string | null = null;

/**
 * Pointer to the discarded transcript, written by the extension so the model cannot guess at it.
 * The dropped entries stay in the JSONL, but one line there is a whole turn: a raw grep of a real
 * 230 KB session returned 132 KB for a single word, against 4.8 KB for the bounded form below.
 */
function buildTranscriptNote(sessionFile: string, sessionId: string): string {
	return [
		`Pointer added by the reset extension: this session is ${sessionFile} (session id ${sessionId}). The discarded messages are still in that file.`,
		"One entry per line, so a line can hold a whole turn and run to tens of kilobytes - never cat or grep the file raw. Bound every hit:",
		`grep -o -E '.{0,120}PATTERN.{0,120}' ${sessionFile} | head -20`,
	].join("\n");
}

/** Nearest ancestor of cwd holding .git (directory or worktree file), cwd itself when none does. */
function projectRoot(cwd: string): string {
	const start = resolve(cwd);
	let dir = start;
	for (;;) {
		if (existsSync(join(dir, ".git"))) {
			return dir;
		}
		const parent = dirname(dir);
		if (parent === dir) {
			return start;
		}
		dir = parent;
	}
}

function memoryFile(cwd: string | undefined): string {
	return join(projectRoot(cwd ?? process.cwd()), MEMORY_BASENAME);
}

/** Memory inlined so the first action after a reset is the work itself, not remembering to read. */
function buildMemoryNote(path: string): string {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return `Memory file ${path} could not be read. Read it with the read tool; if it is really absent, ask what to work on.`;
	}
	if (text.trim() === "") {
		return `Memory file ${path} is empty. Read it to confirm, then ask what to work on.`;
	}
	if (text.length <= INLINE_LIMIT) {
		return `Memory file ${path}:\n\n${text}`;
	}
	return `Memory file ${path}, first ${INLINE_LIMIT} of ${text.length} characters:\n\n${text.slice(0, INLINE_LIMIT)}\n\nThe rest is in the file - read it for anything not shown above.`;
}

function buildSummary(memory: string, sessionFile: string | undefined, sessionId: string): string {
	const transcript = sessionFile ? `\n\n${buildTranscriptNote(sessionFile, sessionId)}` : "";
	return [
		"Harness note, written by the reset extension at a reset call.",
		"",
		buildMemoryNote(memory),
		"",
		"Continue the task above from the point it reports, with the next step it names. The memory file is the whole record of the work: whatever it does not state is not known, so re-derive it with tools or ask, and keep any account of the work to what is written there.",
		transcript,
	].join("\n");
}

function buildRefused(memory: string, pin: string): string {
	return [
		"Reset not carried out: this conversation is still intact.",
		"",
		`A reset drops everything that is not outside the conversation, so the memory file has to be the whole story of the work on its own: ${MEMORY_CHECKLIST}.`,
		"",
		MEMORY_RULE,
		"",
		`Memory file: ${memory} - read it now and check it against what you would need to resume cold, then write whatever is missing.`,
		"",
		`When the memory file is complete, call reset again with confirm set to ${pin}. This code is for that one call only.`,
	].join("\n");
}

const ARMED = [
	"Reset armed. At the end of this turn the context is replaced by the harness note carrying the memory file, and you continue from it.",
	"Nothing else in this conversation will be visible there.",
].join("\n");

function buildContextWarning(memory: string, tokens: number, contextWindow: number, percent: number): string {
	return [
		`Harness note, written by the reset extension: ${percent}% of the context window is used (${tokens} of ${contextWindow} tokens).`,
		"",
		"Whatever is not written outside this conversation is about to be lost. This is not a reason to stop the task - hand it over instead.",
		"",
		`1. Bring ${memory} up to date so it stands on its own: it has to hold ${MEMORY_CHECKLIST}. ${MEMORY_RULE}`,
		"2. Call reset. The first call reports what the memory file must still cover and hands out a one-time code; call it again with that code.",
		"",
		"After the reset the memory file is all there is, so a gap in it is work lost. This note is written once per crossing of the threshold.",
	].join("\n");
}

/**
 * Checked at every turn boundary, written once per crossing of WARN_PERCENT: the flag holds off
 * while the usage keeps climbing, and re-arms below the threshold so a run after a reset or a
 * compaction is warned again when it fills up.
 *
 * No `continue`: mid-run the note simply reaches the model on its next turn, and once the agent has
 * settled there is no work left to warn about.
 */
function watchContext(ctx: ExtensionContext): BoundaryResult | undefined {
	const usage = ctx.getContextUsage();
	if (!usage || usage.tokens === null || usage.percent === null) {
		return;
	}
	const percent = Math.floor(usage.percent);
	if (percent < WARN_PERCENT) {
		contextWarned = false;
		return;
	}
	if (contextWarned) {
		return;
	}
	contextWarned = true;
	const memory = memoryFile(ctx.cwd);
	if (ctx.hasUI) {
		ctx.ui.notify(`Context ${percent}% full: update ${memory}, then call reset`, "warning");
	}
	return {
		entries: [
			{
				type: "custom_message",
				customType: "reset/context-warning",
				content: buildContextWarning(memory, usage.tokens, usage.contextWindow, percent),
				display: true,
			},
		],
	};
}

const resetTool = defineTool({
	name: "reset",
	label: "Reset",
	description:
		"Discard this context and continue the work from the memory file - memory.md in " +
		MEMORY_LOCATION +
		", always under that name. Call it when the conversation is no longer worth its context: after a long investigation, before starting the implementation phase, or when you are repeating yourself. " +
		MEMORY_RULE +
		" Everything not written in the memory file is lost, so the first call only reports what to check: bring the memory file up to date, then call reset again with the code it gives. Write to the memory file as you work, not only before a reset.",
	promptSnippet: "Discard this context and continue the work from memory.md in the project root",
	promptGuidelines: [
		`Keep memory.md in ${MEMORY_LOCATION} current while you work, not only before a reset: the task, the constraints, what is done and verified, where the work stands, next steps, file paths, running processes.`,
		`Write only what the source code does not already say and a couple of web queries will not return, in compact lines rather than prose - every character in the memory file is a character less of working context.`,
		"Expect the first reset call to report what the memory file must hold and to hand out a one-time code: fill the gaps it names, then call reset again with that code.",
		"Call reset alone, or last in a tool batch, and never twice in a row: after it you are already continuing from the memory file.",
	],
	parameters: Type.Object({
		confirm: Type.Optional(
			Type.String({ description: "One-time code reported by a reset call that was not carried out." }),
		),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const memory = memoryFile(ctx?.cwd);
		const confirm = (params.confirm ?? "").trim();
		if (pendingPin === null || confirm !== pendingPin) {
			const issued = (pendingPin = String(randomInt(1000, 10000)));
			return {
				content: [{ type: "text", text: buildRefused(memory, issued) }],
				details: { carried_out: false, memory_file: memory },
			};
		}
		pendingPin = null;
		armed = true;
		return {
			content: [{ type: "text", text: ARMED }],
			details: { carried_out: true, memory_file: memory },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(resetTool);

	// A fresh or resumed session starts with unknown usage, and its percent may already sit above the
	// threshold, so the flag must not carry over from the session before it.
	pi.on("session_start", () => {
		contextWarned = false;
	});

	pi.on("turn_end", (event, ctx) => {
		if (!armed) {
			return watchContext(ctx);
		}
		armed = false;
		contextWarned = false;
		const summary = buildSummary(
			memoryFile(ctx.cwd),
			ctx.sessionManager.getSessionFile(),
			ctx.sessionManager.getSessionId(),
		);
		if (ctx.hasUI) {
			ctx.ui.notify("Reset: context discarded at end of turn", "info");
		}

		// Without runnable context the compaction is still committed, so the memory note
		// survives to whatever the next request is, but Pi would reject continuation.
		const entries = [{ type: "compaction" as const, summary, firstKeptEntryId: null }];
		if (event.outcome !== "completed" || !event.context.canContinue) {
			return { entries };
		}
		return { entries, continue: true };
	});
}
