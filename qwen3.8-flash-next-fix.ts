/**
 * qwen3.8-flash-next-fix — fence the confabulated Aliyun relay URL (and the IMDS
 * address) for the Qwen3.8-Flash-Next family, then keep the dead call out of context.
 *
 * This family completes a short "https://..." prefix into a signed Aliyun OSS
 * "file proxy" relay link and hands it to web_read / web_grep / curl as if it had
 * read it somewhere. In our own sessions: 4 fabricated dials in 797 assistant turns
 * of unsloth UD-Q4/Q5_K_XL, 0 in ~30k turns of every other model. Same template
 * family as https://github.com/wtogami/qwen-block-proxy-artifacts reports for
 * NVFP4 / EXL3 / FP8 and the vendor API — so it is base-model, not quant.
 *
 * Why a fence and not weights: that repo's PLE n-gram row ablation (SURGERY.md)
 * zeroed the igniter rows and the model then dialed never-before-seen members of
 * the family, escaping any host-anchored rule set. The generative grammar lives in
 * the LM weights; ablation moves the target, it does not shrink it.
 *
 * Two stages, both model-agnostic in mechanism:
 *  1. `tool_call` blocks the call before anything dials out, with a reason that
 *     says out loud that only the URL was wrong, so the model does not start
 *     re-deriving reasoning that was correct.
 *  2. `context` scrubs the dead call from the LLM view: the fabricated URL becomes
 *     a marker inside its own argument, and every blocked result except the newest
 *     collapses to a stub line. The transcript keeps the originals; only the next
 *     provider requests see the compact form (one cache break per blocked call).
 *
 * Rules stay host-shaped on purpose: bare "aliyuncs" / "proxy_temp_file" mentions
 * must pass, since the shipped qwen-token-plan providers use real Aliyun endpoints
 * (token-plan.<region>.maas...compatible-mode/v1) and Qwen docs reference real
 * bucket assets. Consequence for forensics: a command containing a full literal
 * incident host is itself blocked — grep for a fragment, or split the literal.
 *
 * Blocked-result text carries no host-shaped span either, so an echo of it can
 * never re-trip the fence.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const TYPE = "qwen3.8-flash-next-fix";
const SCRUBBED = "<blocked: memorized relay URL>";
const CANCELLED = "Cancelled by the qwen3.8-flash-next url fence";

const RELAY_FULL =
  `The call never left this machine, and nothing else about it was wrong: the plan, the other arguments and the reasoning around them all stand, so do not re-derive them and do not hunt for a flaw in your logic.\n` +
  `Only the URL is bad, and it came from your weights rather than from this conversation. This model family completes a short "https://" prefix into a signed third-party relay-bucket link (Expires / OSSAccessKeyId / Signature). No search result or page in this conversation ever contained it, and the bucket is dead for everyone, so it will look exactly as plausible the next time.\n` +
  `Do not retry it and do not re-spell it with a different trace or request id. Take the publisher URL from an earlier search result or page read and call the tool with that one; if this conversation holds no such URL, go get one (search, or read the index page) instead of writing a link from memory.`;

const RELAY_TERSE =
  `Only the URL was wrong — it is a relay-bucket template this family memorized, not a link from this conversation, and it is unfetchable. The rest of the call and your reasoning stand: do not re-derive them, do not re-dial this link. Fetch the publisher URL from an earlier result, or search for it first.`;

const IMDS_FULL =
  `The call never left this machine, and the rest of it was fine, so do not re-derive a plan that was not the problem.\n` +
  `A cloud instance-metadata address hands out the machine's short-lived credentials. Reaching for one is a credential-theft primitive, not a way to fetch content, and nothing in this conversation asked for it. This model family has been observed completing curl commands into that address out of the same kind of memorized template.\n` +
  `Do not retry it and do not try a different metadata address in its place. Continue without any metadata address.`;

const IMDS_TERSE =
  `Cloud metadata address (credential surface), never needed by a task. Your reasoning stands; do not re-dial it or substitute another metadata address — continue without it.`;

type Rule = { pattern: RegExp; why: string; full: string; terse: string };

// Character classes so that this file's own text, and a plain grep for the host,
// do not match the fence they are being inspected with.
const RULES: Rule[] = [
  {
    pattern: /routify[-]file[-]proxy[-]sg[.]oss-ap-southeast-1[.]aliyuncs[.]com/i,
    why: "observed incident host, dead relay bucket",
    full: RELAY_FULL,
    terse: RELAY_TERSE,
  },
  {
    pattern: /routify[\w.-]{0,12}file[\w.-]{0,56}aliyuncs[.](com|io)/i,
    why: "relay bucket label on an Aliyun OSS endpoint (family form, .com or .io)",
    full: RELAY_FULL,
    terse: RELAY_TERSE,
  },
  {
    pattern:
      /(?:^|[^\d.])169[.]254[.]169[.]254(?:$|[^\d.])|(?:^|[^\d.])100[.]100[.]100[.]200(?:$|[^\d.])|metadata[.]google[.]internal/i,
    why: "cloud instance-metadata address",
    full: IMDS_FULL,
    terse: IMDS_TERSE,
  },
];

const STUB =
  `[url fence: this call was cancelled. Its URL was a memorized relay template, not a link from this conversation; the reasoning around it was correct. Full explanation was delivered in that turn. Do not re-dial such a link.]`;

function matchRule(s: string): Rule | undefined {
  return RULES.find((r) => r.pattern.test(s));
}

// The rules match a host (or an address), but the junk to remove is the whole
// confabulated dial: path and signature would otherwise stay in context.
const URL_SPAN = /\bhttps?:\/\/[^\s"'`<>|\\]+/gi;
const TOKEN_END = /[\s"'`<>\\,;]/;

function scrubString(s: string): { value: string; hit?: Rule } {
  let hit: Rule | undefined;
  const urls = s.replace(URL_SPAN, (u) => {
    const r = matchRule(u);
    if (!r) return u;
    hit ??= r;
    return SCRUBBED;
  });
  if (hit) return { value: urls, hit };

  const rule = matchRule(s); // scheme-less host, or a bare address
  if (!rule) return { value: s };
  const m = s.match(rule.pattern)!;
  let start = m.index;
  let end = m.index + m[0].length;
  while (start > 0 && !TOKEN_END.test(s[start - 1])) start--;
  while (end < s.length && !TOKEN_END.test(s[end])) end++;
  return { value: s.slice(0, start) + SCRUBBED + s.slice(end), hit: rule };
}

/** Copy of `value` with every blocked dial replaced by SCRUBBED, plus the first rule that fired. */
function scrub(value: unknown, depth = 0): { value: unknown; hit: Rule | undefined } {
  if (typeof value === "string") {
    const { value: v, hit } = scrubString(value);
    return { value: v, hit };
  }
  if (depth > 6 || typeof value !== "object" || value === null) return { value, hit: undefined };
  let hit: Rule | undefined;
  if (Array.isArray(value)) {
    const out = value.map((item) => {
      const s = scrub(item, depth + 1);
      hit ??= s.hit;
      return s.value;
    });
    return { value: out, hit };
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value)) {
    const s = scrub(v, depth + 1);
    hit ??= s.hit;
    out[k] = s.value;
  }
  return { value: out, hit };
}

const fix = Object.assign(
  (pi: ExtensionAPI) => {
  // toolCallIds blocked in this branch; rebuilt on session_start so a resume or
  // fork keeps collapsing the old corpses.
  const blocked = new Set<string>();
  let toldFull = false;

  pi.on("session_start", (_event, ctx) => {
    blocked.clear();
    toldFull = false;
    for (const e of ctx.sessionManager.getBranch()) {
      if (e.type === "custom" && e.customType === TYPE) {
        const d = e.data as { toolCallId?: string } | undefined;
        if (d?.toolCallId) blocked.add(d.toolCallId);
      }
    }
  });

  pi.on("tool_call", (event) => {
    const { hit } = scrub(event.input);
    if (!hit) return undefined;

    blocked.add(event.toolCallId);
    pi.appendEntry(TYPE, { toolCallId: event.toolCallId });

    // Full explanation once per session, one-liner after: the guidance is what
    // drives the self-correction, repeating it would spend the context it protects.
    const guidance = toldFull ? hit.terse : hit.full;
    toldFull = true;
    return { block: true, reason: `${CANCELLED} (${hit.why}). ${guidance}` };
  });

  pi.on("context", (event) => {
    if (blocked.size === 0) return undefined;
    const messages = event.messages as any[];

    let newest = -1;
    for (let i = messages.length - 1; i >= 0; i--) {
      if (messages[i].role === "toolResult" && blocked.has(messages[i].toolCallId)) {
        newest = i;
        break;
      }
    }

    let changed = false;
    const next = messages.map((msg, i) => {
      if (msg.role === "toolResult" && blocked.has(msg.toolCallId)) {
        if (i === newest) return msg;
        changed = true;
        return { ...msg, content: [{ type: "text", text: STUB }] };
      }
      if (msg.role !== "assistant" || !Array.isArray(msg.content)) return msg;

      let touched = false;
      const content = msg.content.map((block: any) => {
        if (block.type !== "toolCall") return block;
        const s = scrub(block.arguments);
        if (!s.hit) return block;
        touched = true;
        return { ...block, arguments: s.value };
      });
      if (!touched) return msg;
      changed = true;
      return { ...msg, content };
    });

    return changed ? { messages: next } : undefined;
  });
  },
  // Test surface: the module keeps exactly one export, and a loader that walks
  // exports only ever sees the factory.
  { RULES, scrub, matchRule, SCRUBBED, STUB },
);

export default fix;
