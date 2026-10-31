/**
 * compaction-summary-unwrap — hand the compaction summary to the model as a plain user message.
 *
 * pi frames the summary with fixed text (`COMPACTION_SUMMARY_PREFIX` / `COMPACTION_SUMMARY_SUFFIX` in
 * `pi/dist/core/messages.js`), so the first request after a `done` reset opens with "The conversation
 * history before this point was compacted into the following summary:" and a `<summary>` block around the
 * one line the reset carries. Qwen3.8-Flash-Next reads that frame as the marker of a summarized session
 * from its own training and continues a borrowed trajectory instead of opening the file it was pointed at:
 * the frame plus the handover line went off topic in 19 of 24 greedy turns (and 16 of 24 in the session
 * that lost the «Порог» work to a phantom docx job), while the same line as a plain user message held the
 * task in 48 of 48. A written-out summary does not save the frame: 11 of 24 off topic with it, 0 of 24
 * without it. The frame is the trigger, not the brevity of what is inside it.
 *
 * The frame has no setting, so it is dropped on the way out. The `context` handler runs on AgentMessage[]
 * before `convertToLlm` (`pi-agent-core/dist/agent-loop.js`), which is where the frame is added: the
 * `compaction` entry and its `compactionSummary` message stay in the session file exactly as pi writes
 * them, and only the outgoing request sees the bare line. Same trick as the sibling Qwen fix — the model's
 * view is corrected in the harness, not in the package.
 *
 * `branch_summary` messages carry the same kind of frame and would need the same treatment; not touched
 * here, since no branch navigation is in use.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** One compaction summary as the model should see it: the summary text, in a user message, framed by nothing. */
function unwrapOne(message: any): any {
	const summary = typeof message.summary === "string" ? message.summary : "";
	if (summary.length === 0) return message; // an empty summary keeps pi's own frame
	return { role: "user", content: [{ type: "text", text: summary }], timestamp: message.timestamp };
}

/** Replace every framed summary in the outgoing view; the list is returned untouched when there is none. */
function unwrap(messages: any[]): { changed: boolean; messages: any[] } {
	if (!messages.some((m) => m?.role === "compactionSummary")) return { changed: false, messages };
	return { changed: true, messages: messages.map((m) => (m?.role === "compactionSummary" ? unwrapOne(m) : m)) };
}

const unwrapFix = Object.assign(
	(pi: ExtensionAPI) => {
		pi.on("context", (event) => {
			const { changed, messages } = unwrap(event.messages as any[]);
			return changed ? { messages } : undefined;
		});
	},
	// Test surface: the module keeps exactly one export, and a loader that walks exports only ever sees the factory.
	{ unwrap, unwrapOne },
);

export default unwrapFix;
