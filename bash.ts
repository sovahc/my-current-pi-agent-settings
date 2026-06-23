import { Type } from "@mariozechner/pi-ai";
import {
  defineTool,
  type ExtensionAPI,
  createLocalBashOperations,
  truncateTail,
  formatSize,
} from "@mariozechner/pi-coding-agent";
import { randomBytes } from "node:crypto";
import { createWriteStream, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MAX_BYTES = 10 * 1024;
const MAX_LINES = 2000;
const MAX_ROLLING_BYTES = MAX_BYTES * 2;

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "")
    .replace(/\x1b\][^\x07]*\x07/g, "")
    .replace(/\r/g, "");
}

function sanitizeBinary(text: string): string {
  return Array.from(text)
    .filter((c) => {
      const code = c.codePointAt(0)!;
      if (code === 0x09 || code === 0x0a || code === 0x0d) return true;
      if (code <= 0x1f) return false;
      if (code >= 0xfff9 && code <= 0xfffb) return false;
      return true;
    })
    .join("");
}

const bashTool = defineTool({
  name: "bash",
  label: "bash",
  description: `Execute a bash command in the current working directory. Returns stdout and stderr. Output is truncated to last ${MAX_LINES} lines or ${MAX_BYTES / 1024}KB (whichever is hit first). If truncated, full output is saved to a temp file. Optionally provide a timeout in seconds.`,
  promptSnippet: "Execute bash commands (ls, grep, find, etc.)",
  parameters: Type.Object({
    command: Type.String({ description: "Bash command to execute" }),
    timeout: Type.Optional(
      Type.Number({ description: "Timeout in seconds (optional, no default timeout)" }),
    ),
  }),

  async execute(_id, { command, timeout }, signal, _onUpdate, _ctx) {
    const ops = createLocalBashOperations();
    const chunks: string[] = [];
    let outputBytes = 0;
    let totalBytes = 0;
    let tempPath: string | undefined;
    let tempStream: ReturnType<typeof createWriteStream> | undefined;

    const ensureTemp = () => {
      if (tempPath) return;
      tempPath = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
      tempStream = createWriteStream(tempPath);
      for (const c of chunks) tempStream.write(c);
    };

    const onData = (data: Buffer) => {
      const text = sanitizeBinary(stripAnsi(data.toString("utf-8")));
      totalBytes += data.length;

      if (totalBytes > MAX_BYTES) ensureTemp();
      if (tempStream) tempStream.write(text);

      chunks.push(text);
      outputBytes += text.length;
      while (outputBytes > MAX_ROLLING_BYTES && chunks.length > 1) {
        const removed = chunks.shift()!;
        outputBytes -= removed.length;
      }
    };

    try {
      const result = await ops.exec(command, process.cwd(), { onData, signal, timeout });
      const full = chunks.join("");
      const truncation = truncateTail(full, { maxLines: MAX_LINES, maxBytes: MAX_BYTES });

      if (truncation.truncated) ensureTemp();
      if (tempStream) tempStream.end();

      let text = truncation.truncated ? truncation.content : full;
      let details: { truncation?: typeof truncation; fullOutputPath?: string } = {};

      if (truncation.truncated) {
        details = { truncation, fullOutputPath: tempPath };
        const start = truncation.totalLines - truncation.outputLines + 1;
        const end = truncation.totalLines;
        text += `\n\n[Full output: ${tempPath}]`;
        text += `\n[Showing lines ${start}-${end} of ${truncation.totalLines}]`;
      }

      if (result.exitCode !== 0 && result.exitCode !== null) {
        throw new Error(`${text ? text + "\n\n" : ""}Command exited with code ${result.exitCode}`);
      }

      return { content: [{ type: "text", text }] as any, details };
    } catch (err: any) {
      if (tempStream) tempStream.end();

      if (signal?.aborted) {
        const full = chunks.join("");
        const truncation = truncateTail(full, { maxLines: MAX_LINES, maxBytes: MAX_BYTES });
        if (truncation.truncated) ensureTemp();
        if (tempStream) tempStream.end();
        throw new Error(`${truncation.content ? truncation.content + "\n\n" : ""}Command aborted`);
      }

      if (err?.message?.startsWith("timeout:")) {
        const secs = err.message.split(":")[1];
        throw new Error(`${chunks.join("") ? chunks.join("") + "\n\n" : ""}Command timed out after ${secs} seconds`);
      }

      throw err;
    }
  },
});

export default function (pi: ExtensionAPI) {
  pi.registerTool(bashTool);
}
