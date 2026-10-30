/**
 * Reset tool - discard this context and continue the work from the memory file.
 *
 * Continuity lives outside the conversation: the model keeps the memory file current while it
 * works, so a reset never has to generate a long handover text in one tool argument - the place
 * where a local model closes the string early and the continuation inherits a half-note.
 * Nothing checks the memory file; a reset with a thin memory file simply continues thin.
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { randomInt } from "node:crypto";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";

const MEMORY_FILE = `${homedir()}/memory.md`;
const INLINE_LIMIT = 12000;

/** Set by an armed reset call, consumed by the next turn_end. */
let armed = false;

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

/** Memory inlined so the first action after a reset is the work itself, not remembering to read. */
function buildMemoryNote(): string {
	let text: string;
	try {
		text = readFileSync(MEMORY_FILE, "utf8");
	} catch {
		return `Memory file ${MEMORY_FILE} could not be read. Read it with the read tool; if it is really absent, ask what to work on.`;
	}
	if (text.trim() === "") {
		return `Memory file ${MEMORY_FILE} is empty. Read it to confirm, then ask what to work on.`;
	}
	if (text.length <= INLINE_LIMIT) {
		return `Memory file ${MEMORY_FILE}:\n\n${text}`;
	}
	return `Memory file ${MEMORY_FILE}, first ${INLINE_LIMIT} of ${text.length} characters:\n\n${text.slice(0, INLINE_LIMIT)}\n\nThe rest is in the file - read it for anything not shown above.`;
}

function buildSummary(sessionFile: string | undefined, sessionId: string): string {
	const transcript = sessionFile ? `\n\n${buildTranscriptNote(sessionFile, sessionId)}` : "";
	return [
		"Harness note, written by the reset extension at a reset call.",
		"",
		buildMemoryNote(),
		"",
		"Continue the task above from the point it reports, with the next step it names. The memory file is the whole record of the work: whatever it does not state is not known, so re-derive it with tools or ask, and keep any account of the work to what is written there.",
		transcript,
	].join("\n");
}

function buildRefused(pin: string): string {
	return [
		"Reset not carried out: this conversation is still intact.",
		"",
		"A reset drops everything that is not outside the conversation, so the memory file has to be the whole story of the work on its own: the task in the words it was given, the constraints that still hold, what is done and verified, where the work stands, the next steps, the file paths that matter, and any process still running.",
		"",
		`Memory file: ${MEMORY_FILE} - read it now and check it against what you would need to resume cold, then write whatever is missing.`,
		"",
		`When the memory file is complete, call reset again with confirm set to ${pin}. This code is for that one call only.`,
	].join("\n");
}

const ARMED = [
	"Reset armed. At the end of this turn the context is replaced by the harness note carrying the memory file, and you continue from it.",
	"Nothing else in this conversation will be visible there.",
].join("\n");

const resetTool = defineTool({
	name: "reset",
	label: "Reset",
	description:
		"Discard this context and continue the work from the memory file. Call it when the conversation is no longer worth its context: after a long investigation, before starting the implementation phase, or when you are repeating yourself. Everything not written in the memory file is lost, so the first call only reports what to check: bring the memory file up to date, then call reset again with the code it gives. Write to the memory file as you work, not only before a reset.",
	promptSnippet: "Discard this context and continue the work from the memory file",
	promptGuidelines: [
		`Keep ${MEMORY_FILE} current while you work, not only before a reset: the task, the constraints, what is done and verified, where the work stands, next steps, file paths, running processes.`,
		"Expect the first reset call to report what the memory file must hold and to hand out a one-time code: fill the gaps it names, then call reset again with that code.",
		"Call reset alone, or last in a tool batch, and never twice in a row: after it you are already continuing from the memory file.",
	],
	parameters: Type.Object({
		confirm: Type.Optional(
			Type.String({ description: "One-time code reported by a reset call that was not carried out." }),
		),
	}),

	async execute(_toolCallId, params) {
		const confirm = (params.confirm ?? "").trim();
		if (pendingPin === null || confirm !== pendingPin) {
			const issued = (pendingPin = String(randomInt(1000, 10000)));
			return {
				content: [{ type: "text", text: buildRefused(issued) }],
				details: { carried_out: false, memory_file: MEMORY_FILE },
			};
		}
		pendingPin = null;
		armed = true;
		return {
			content: [{ type: "text", text: ARMED }],
			details: { carried_out: true, memory_file: MEMORY_FILE },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(resetTool);

	pi.on("turn_end", (event, ctx) => {
		if (!armed) {
			return;
		}
		armed = false;
		const summary = buildSummary(ctx.sessionManager.getSessionFile(), ctx.sessionManager.getSessionId());
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
