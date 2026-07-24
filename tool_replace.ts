/**
 * tool_replace — model-driven context cleanup with visible plaques.
 *
 * Wraps the built-in `read`: when the model replaces a (truncated) read result via
 * replace_tool_output, that read collapses into a one-line plaque in the scrollback
 * (rendered by the wrapped renderResult). Replacements are persisted as CustomEntry,
 * so they survive reload and fork (rebuilt into the cache on session_start). The
 * context hook swaps the original for the replacement text in the LLM view.
 *
 * Scope: toolResult replacement by toolCallId, display plaque for replaced reads,
 * fork-safe persistence. No pi patch.
 */

import { Type } from "@mariozechner/pi-ai";
import { createReadToolDefinition, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

const TYPE = "context-replacement";

export default function (pi: ExtensionAPI) {
  // Runtime cache for the context hook (fast lookup per LLM call).
  const replacements = new Map<string, string>();
  // toolCallId -> invalidate(), populated as read components render, so a staged
  // replacement can force exactly that read component to redraw as a plaque.
  const readInvalidators = new Map<string, () => void>();
  let readWrapped = false;

  // Rebuild cache from persisted entries; wrap read (needs cwd) once per instance.
  pi.on("session_start", (_event, ctx) => {
    replacements.clear();
    const branch = ctx.sessionManager.getBranch();
    for (const e of branch) {
      if (e.type === "custom" && e.customType === TYPE) {
        const d = e.data as { toolCallId: string; text: string } | undefined;
        if (d) replacements.set(d.toolCallId, d.text);
      }
    }

    if (!readWrapped) {
      const builtIn = createReadToolDefinition(ctx.cwd);
      pi.registerTool({
        ...builtIn,
        renderResult(result, options, theme, context) {
          readInvalidators.set(context.toolCallId, context.invalidate);
          const replacement = replacements.get(context.toolCallId);
          if (replacement !== undefined) {
            return new Text(theme.fg("dim", `↻ ${replacement}`), 0, 0);
          }
          return builtIn.renderResult!(result, options, theme, context);
        },
      });
      readWrapped = true;
    }
  });

  // Tool: model replaces a toolResult by id with arbitrary text.
  pi.registerTool({
    name: "replace_tool_output",
    label: "Replace Tool Output",
    description:
      "Replace a large or irrelevant tool result with arbitrary text to free context. " +
      "The original is dropped from future context; only the text you provide remains.",
    parameters: Type.Object({
      toolCallId: Type.String({
        description: "toolCallId of the toolResult to replace (shown in the context tip appended to truncated reads).",
      }),
      replacementText: Type.String({
        description: "Arbitrary text that fully replaces the original output in context.",
      }),
    }),
    async execute(_id, params) {
      replacements.set(params.toolCallId, params.replacementText);
      pi.appendEntry(TYPE, { toolCallId: params.toolCallId, text: params.replacementText });
      readInvalidators.get(params.toolCallId)?.(); // force the read plaque to redraw
      return { content: [{ type: "text", text: `Replaced ${params.toolCallId} in context.` }] };
    },
  });

  // Hint: when read output is truncated, tell the model it can replace it by id.
  pi.on("tool_result", (event) => {
    if (event.toolName !== "read") return;
    if (!event.details?.truncation?.truncated) return;
    const hint =
      `\n\n[Context tip: this read is truncated. If irrelevant, free context with ` +
      `replace_tool_output(toolCallId="${event.toolCallId}", replacementText="..."). ` +
      `replacementText is arbitrary text that fully replaces this output in context. ` +
      `Do not replace outputs you still need.]`;
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
