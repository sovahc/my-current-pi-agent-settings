/**
 * Done tool - discard this context and continue the work from a task file.
 *
 * The task file stands in for both the memory file and a handover text: the model keeps it current
 * while it works, and the reset carries over a single line pointing at it. Nothing is inlined, so
 * the handover costs one line of context whatever the length of the record.
 *
 * The file is checked when the tool is called, not at the turn boundary: a reset pointing at a
 * missing file has already discarded the only conversation that knew where the work stood.
 *
 * Context-usage marks ride on the same boundary: the model does not see the footer percentage, so each
 * crossed level (50, 60, 70, 80, 90%) is announced once as a user-role message. The last three tell it
 * to wrap up, the last one to save and call `done`.
 */

import {
	defineTool,
	type ExtensionAPI,
	type SessionBoundaryDraft,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { statSync } from "node:fs";
import { resolve } from "node:path";

/** Task file of the reset armed by a `done` call, cleared by the turn boundary that carries it out. */
let armed: string | null = null;

/** Context-usage marks, announced once each when the usage crosses the level. */
const LEVELS: ReadonlyArray<{ percent: number; text: string }> = [
	{ percent: 50, text: "Context usage crossed 50%." },
	{ percent: 60, text: "Context usage crossed 60%." },
	{ percent: 70, text: "Warning: context usage crossed 70%. Bring the task file up to date now, then finish the current step." },
	{ percent: 80, text: "Warning: context usage crossed 80%. Finish the current step and update the task file; start nothing new." },
	{ percent: 90, text: "Context usage crossed 90%. Save the work results to the task file and call done now." },
];

/** Highest level announced in the current context, -1 below the first one; follows the usage back down after a reset. */
let announced = -1;

/** Index of the highest level the usage has crossed, -1 below the first one. */
function levelAt(percent: number): number {
	let level = -1;
	for (let i = 0; i < LEVELS.length && percent >= LEVELS[i].percent; i++) {
		level = i;
	}
	return level;
}

/** The one line a cold resume gets: everything else has to come from the file itself. */
function handover(file: string): string {
	return `Read your task - ${file}`;
}

function isFile(path: string): boolean {
	try {
		return statSync(path).isFile();
	} catch {
		return false;
	}
}

const doneTool = defineTool({
	name: "done",
	label: "Done",
	description:
		"Discard this context and continue the work from a task file. Call it when the conversation is no longer " +
		"worth its context: after a long investigation, before starting the implementation phase, or when you are " +
		"repeating yourself. After the call the only thing left of this conversation is the line pointing at the " +
		"file, so keep the file current while you work, not only before the call. Only what cannot be re-derived " +
		"belongs there: what the source code does not say and a couple of web queries will not return - decisions " +
		"and why they were taken, constraints, gotchas, dead ends, the state of the work. Write compact lines, not " +
		"prose.",
	promptSnippet: "Discard this context and continue the work from a task .md file",
	promptGuidelines: [
		"Keep the task file current while you work, not only before a done call: the task in the words it was given, the constraints that still hold, what is done and verified, where the work stands, the next steps, the file paths that matter, any process still running.",
		"Call done alone, or last in a tool batch, and never twice in a row: after it you are already continuing from the task file.",
	],
	parameters: Type.Object({
		task_md: Type.String({
			description: "Path to the task file to continue from. The file has to exist.",
		}),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
		const file = resolve(ctx?.cwd ?? process.cwd(), params.task_md.trim());
		if (!isFile(file)) {
			return {
				content: [
					{
						type: "text",
						text: `Task file ${file} does not exist, so nothing was reset: this conversation is still intact. Write the file, then call done again with its path.`,
					},
				],
				details: { carried_out: false, task_file: file },
			};
		}
		armed = file;
		return {
			content: [{ type: "text", text: handover(file) }],
			details: { carried_out: true, task_file: file },
		};
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(doneTool);

	pi.on("turn_end", (event, ctx) => {
		if (armed === null) {
			return;
		}
		const file = armed;
		armed = null;
		announced = -1;
		if (ctx.hasUI) {
			ctx.ui.notify("Done: context discarded at end of turn", "info");
		}
		const entries: SessionBoundaryDraft[] = [{ type: "compaction", summary: handover(file), firstKeptEntryId: null }];
		// Without runnable context the compaction is still committed, so the handover survives to
		// whatever the next request is, but Pi would reject a continuation.
		if (event.outcome !== "completed" || !event.context.canContinue) {
			return { entries };
		}
		return { entries, continue: true };
	});

	pi.on("turn_end", (event, ctx) => {
		// A compaction draft in the proposal discards this context: there is nothing to announce into it.
		if (event.entries.some((entry) => entry.type === "compaction")) {
			return;
		}
		const percent = ctx.getContextUsage()?.percent;
		if (percent === null || percent === undefined) {
			return;
		}
		const level = levelAt(percent);
		const crossed = level > announced;
		announced = level;
		if (!crossed) {
			return;
		}
		const entries: SessionBoundaryDraft[] = [
			...event.entries,
			{ type: "custom_message", customType: "context-usage", content: LEVELS[level].text, display: true },
		];
		// The last mark is an order: with no pending tool results it gets a request of its own.
		const order = level === LEVELS.length - 1 && event.toolResults.length === 0 && event.outcome === "completed" && event.context.canContinue;
		return order ? { entries, continue: true } : { entries };
	});
}
