/**
 * tool_replace — model-driven context cleanup with visible plaques.
 *
 * One global tool-renderer resolver wraps every tool's renderResult: when the model replaces a
 * result via replace_tool_output, that row collapses into a one-line plaque in the transcript, so
 * the screen says what the context says. Replacements are persisted as CustomEntry, so they
 * survive reload and fork (rebuilt into the cache on session_start). The context hook swaps the
 * original for the replacement text in the LLM view.
 *
 * Scope: toolResult replacement by toolCallId or by offset from the calling tool call, display
 * plaque for any replaced result whose tool has a result renderer, fork-safe persistence.
 * No pi patch.
 */

import { Type } from "@mariozechner/pi-ai";
import { type ExtensionAPI, type ExtensionToolContext } from "@mariozechner/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const TYPE = "context-replacement";
const TOOL_NAME = "replace_tool_output";

const err = (text: string) => ({ isError: true, content: [{ type: "text" as const, text }] });

/**
 * Tool results on the current branch, oldest first — the sequence offsets index into.
 * Includes this tool's own results, so the id path can tell a real id from a typo; the
 * offset path filters them out, which keeps `-1`/`-2` pointing at real work even when
 * several replaces run in one batch. Off the branch there is nothing to replace: the
 * context hook only ever sees branch messages.
 */
function branchToolResults(ctx: ExtensionToolContext) {
  const results: { toolCallId: string; toolName: string }[] = [];
  for (const entry of ctx.sessionManager.getBranch()) {
    if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
    results.push({ toolCallId: entry.message.toolCallId, toolName: entry.message.toolName });
  }
  return results;
}

export default function (pi: ExtensionAPI) {
  // Runtime cache for the context hook and the plaque renderer (fast lookup per LLM call).
  const replacements = new Map<string, string>();
  // toolCallId -> invalidate(), populated as any tool row renders, so a staged replacement
  // can force exactly that row to redraw as a plaque.
  const invalidators = new Map<string, () => void>();

  // Plaque renderer for every tool. Resolvers run before the tool's own renderers, for any tool
  // name — built-in, extension-registered, or absent from this session's registry — so one
  // wrapper covers them all without needing cwd or a per-tool definition.
  pi.registerToolRenderer((_toolName, next) => {
    const base = next();
    const renderResult = base?.renderResult;
    // A tool with no renderResult is left alone: pi draws those rows with its own raw-text
    // fallback, and a renderResult returning nothing blanks the row rather than falling back.
    if (!renderResult) return base;
    return {
      ...base,
      renderResult(result, options, theme, context) {
        invalidators.set(context.toolCallId, context.invalidate);
        const replacement = replacements.get(context.toolCallId);
        if (replacement === undefined) return renderResult(result, options, theme, context);
        return new Text(theme.fg("dim", `↻ ${replacement}`), 0, 0);
      },
    };
  });

  // Rebuild the cache from persisted entries.
  pi.on("session_start", (_event, ctx) => {
    replacements.clear();
    const branch = ctx.sessionManager.getBranch();
    for (const e of branch) {
      if (e.type === "custom" && e.customType === TYPE) {
        const d = e.data as { toolCallId: string; text: string } | undefined;
        if (d) replacements.set(d.toolCallId, d.text);
      }
    }
  });

  // Tool: model replaces a toolResult with arbitrary text, by offset or by id.
  pi.registerTool({
    name: TOOL_NAME,
    label: "Replace Tool Output",
    description:
      "Drop a tool result you no longer need: its content is replaced by replacementText in all later context. " +
      "Address the target by offset from this call (-1 = the tool result right before this call, -2 = the one before that) " +
      "or by toolCallId. " +
      "Call it as soon as a result stops mattering: a read of a file that turned out irrelevant — replace it in the turn " +
      "right after reading it, before anything else; a call that failed (a rejected edit, an errored command) — once the " +
      "retry succeeds, replace the failed call with a short text saying what went wrong and that it is already fixed. " +
      "Keep replacementText to one short line: what the result was and why it is gone. " +
      "Never replace a result you still need.",
    parameters: Type.Object({
      offset: Type.Optional(Type.Integer({
        minimum: -10,
        maximum: -1,
        description: "Position of the target relative to this call: -1 = the tool result right before it, -2 = the one before that. Use instead of toolCallId.",
      })),
      toolCallId: Type.Optional(Type.String({
        description: "toolCallId of the toolResult to replace, when offset cannot address it (shown in the context tip appended to truncated reads).",
      })),
      replacementText: Type.String({
        description: "One short line stating what the result was and why it is gone; it fully replaces the original output in context.",
      }),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const results = branchToolResults(ctx);
      let target = params.toolCallId;
      let label = "";
      if (target) {
        // An unknown id must fail loudly: accepting it reported success while the context
        // hook had nothing to swap, so a typo silently left the original output in place.
        const hit = results.find((r) => r.toolCallId === target);
        if (!hit) {
          return err(`toolCallId "${target}" is not a tool result on the current branch: nothing was replaced. Use offset (-1 = the tool result right before this call), or copy the id from the context tip of a truncated read.`);
        }
        label = `${hit.toolName} result ${target}`;
      } else if (params.offset !== undefined) {
        const prior = results.filter((r) => r.toolName !== TOOL_NAME);
        const hit = prior[prior.length + params.offset];
        if (params.offset >= 0 || !hit) {
          return err(`offset ${params.offset} is out of range: ${prior.length} tool result(s) precede this call.`);
        }
        target = hit.toolCallId;
        label = `${hit.toolName} result at offset ${params.offset}`;
      } else {
        return err(`Set offset (-1 = the tool result right before this call, -2 = the one before that) or toolCallId.`);
      }
      replacements.set(target, params.replacementText);
      pi.appendEntry(TYPE, { toolCallId: target, text: params.replacementText });
      invalidators.get(target)?.(); // force that row to redraw as a plaque
      return { content: [{ type: "text", text: `Replaced ${label} in context.` }] };
    },
  });

  // Hint: when read output is truncated, tell the model to drop it by offset right away.
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read") return;
    if (!event.details?.truncation?.truncated) return;
    const hint =
      `\n\n[Context tip: this read is truncated. If it is irrelevant, drop it now with ` +
      `replace_tool_output(offset=-1, replacementText="one line") — -1 is this read, the result right before ` +
      `that call; count back if other calls ran after it. toolCallId="${event.toolCallId}" addresses it directly.]`;
    return { content: [...event.content, { type: "text" as const, text: hint }] };
  });

  // Apply staged replacements to the LLM view (fires before each LLM call).
  pi.on("context", (event) => {
    if (replacements.size === 0) return undefined;
    let changed = false;
    const messages = event.messages.map((msg: any) => {
      if (msg.role !== "toolResult") return msg;
      const replacement = replacements.get(msg.toolCallId);
      if (replacement === undefined) return msg;
      changed = true;
      return { ...msg, content: [{ type: "text", text: replacement }] };
    });
    return changed ? { messages } : undefined;
  });
}
