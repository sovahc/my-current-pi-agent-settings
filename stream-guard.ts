import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── StreamGuard constants ──────────────────────────────────────────────
const WINDOW = 24;
const MIN_LINE_LEN = 6;
const MAX_DISTINCT = 3;
const PREFIX_MATCH = 20;
const PREFIX_WORDS = 4;
const LONG_LINE_LEN = 20;
const GLOBAL_REPEAT_LIMIT = 5;

// Detect leaked tool-call markup in content channel (e.g. `<function=...>`)
const TOOL_MARKUP_RE = /<function=/i;

type ProseChannel = "reasoning" | "content";

// ── StreamGuard class ──────────────────────────────────────────────────
class StreamGuard {
  private readonly prev: Record<ProseChannel, string> = {
    reasoning: "",
    content: "",
  };
  private readonly partial: Record<ProseChannel, string> = {
    reasoning: "",
    content: "",
  };
  private readonly lines: Record<ProseChannel, string[]> = {
    reasoning: [],
    content: [],
  };
  private readonly counts: Record<ProseChannel, Map<string, number>> = {
    reasoning: new Map(),
    content: new Map(),
  };
  private contentIsToolMarkup = false;

  /** Reset all state — called at the start of each new assistant message. */
  reset(): void {
    this.prev.reasoning = "";
    this.prev.content = "";
    this.partial.reasoning = "";
    this.partial.content = "";
    this.lines.reasoning = [];
    this.lines.content = [];
    this.counts.reasoning = new Map();
    this.counts.content = new Map();
    this.contentIsToolMarkup = false;
  }

  /**
   * Observe a full (accumulated) text chunk for a given channel.
   * Returns `true` when degeneration is detected.
   */
  observe(fullText: string, channel: ProseChannel): boolean {
    // Content has become leaked tool-call markup — skip prose-loop checks
    if (channel === "content" && this.contentIsToolMarkup) {
      return false;
    }

    const delta = fullText.slice(this.prev[channel].length);
    this.prev[channel] = fullText;

    this.partial[channel] += delta;

    // Check for tool-call leak in accumulated content
    if (
      channel === "content" &&
      !this.contentIsToolMarkup &&
      TOOL_MARKUP_RE.test(this.partial.content)
    ) {
      this.contentIsToolMarkup = true;
      return false;
    }

    const segments = this.partial[channel].split("\n");
    this.partial[channel] = segments.pop() ?? "";

    for (const segment of segments) {
      const trimmed = segment.trim();

      if (trimmed.length < MIN_LINE_LEN) {
        continue;
      }

      // Period-agnostic: a long line repeated many times anywhere in the stream
      // is a loop even when the repeating block is larger than WINDOW.
      if (trimmed.length >= LONG_LINE_LEN) {
        const counts = this.counts[channel];
        const seen = (counts.get(trimmed) ?? 0) + 1;
        counts.set(trimmed, seen);

        if (seen >= GLOBAL_REPEAT_LIMIT) {
          return true;
        }
      }

      const window = this.lines[channel];
      window.push(trimmed);

      if (window.length > WINDOW) {
        window.shift();
      }

      // Check only when the window is fully populated
      if (window.length === WINDOW && isRepetitive(window)) {
        return true;
      }
    }

    return false;
  }
}

function isRepetitive(window: string[]): boolean {
  const distinct = new Set(window).size;

  if (distinct <= MAX_DISTINCT) {
    return true;
  }

  // Block repetition: the model loops a multi-line block.
  // Half-or-more of the window being duplicates is a loop no real prose produces.
  if (distinct <= Math.floor(WINDOW / 2)) {
    return true;
  }

  // Templated repetition: single pass with early exit
  const prefixCounts = new Map<string, number>();

  for (const line of window) {
    const prefix = line.split(/\s+/).slice(0, PREFIX_WORDS).join(" ");
    const next = (prefixCounts.get(prefix) ?? 0) + 1;
    prefixCounts.set(prefix, next);

    if (next >= PREFIX_MATCH) {
      return true;
    }
  }

  return false;
}

// ── Extension entry point ──────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  const guard = new StreamGuard();

  pi.on("message_start", async (event) => {
    if (event.message.role === "assistant") {
      guard.reset();
    }
  });

  pi.on("message_update", async (event, ctx) => {
    if (event.message.role !== "assistant") return;
    if (!Array.isArray(event.message.content)) return;

    for (const block of event.message.content) {
      if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
        if (guard.observe(block.text, "content")) {
          ctx.abort();
          return;
        }
      }
      if (block.type === "thinking" && typeof block.text === "string" && block.text.length > 0) {
        if (guard.observe(block.text, "reasoning")) {
          ctx.abort();
          return;
        }
      }
    }
  });
}
