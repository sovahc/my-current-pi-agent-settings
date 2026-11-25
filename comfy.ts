/**
 * ComfyUI tool for the machine where one GPU (24 GB) and its RAM (62 GB) are shared with the Strata LLM server:
 * a loaded Strata holds ~22 GB of VRAM and ~52 GB of RAM, so ComfyUI gets the card only between two LLM requests.
 *
 * A call is the whole batch, in that order: the conversation's K/V cache goes to a file (POST /slots/0?action=save,
 * llama-server's API; Strata's own image jobs do the same before an unload) -> POST /unload to Strata (the engine
 * exits in about a second; the server stays) -> ComfyUI runs every job -> POST /free (its models go in under two
 * seconds; the process stays at ~0.5 GB VRAM and is started here when it is down) -> POST /load and
 * /slots/0?action=restore: the engine is back with the conversation's cache, so the next request reads only its
 * new tokens instead of the whole prompt (a prefill of 190K tokens took 83 s; the restore is a file read).
 * The session files land in Strata's slot_save_path; a SAVE keeps the engine's RAM floor
 * (--conversation-cache-min-free-mib, 512 MiB here because under 1 GiB is free with the model loaded).
 */

import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { execFileSync, spawn } from "node:child_process";
import { closeSync, existsSync, openSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { extname, join, resolve } from "node:path";

// Loopback must not go through the proxy the other tools use (browser.ts sets the same).
process.env.NO_PROXY ??= "localhost,127.0.0.1,::1";

const STRATA = "http://127.0.0.1:8080";
const COMFY = "http://127.0.0.1:8188";
const COMFY_DIR = join(homedir(), "ComfyUI");
const COMFY_LOG = "/tmp/comfyui.log";
// Below this much free VRAM after /free the ComfyUI process is ended (and started by the next call): Strata's
// min_free_vram_mib would otherwise refuse to load on a leaked card.
const VRAM_FREE_FLOOR_MB = 20_000;
const SLOT_FILE = "comfy-session.bin";
// Below this many saved tokens the next request's prefill (about 2250 tok/s read) is cheaper than a save and a restore.
const MIN_SAVE_TOKENS = 16_000;
const INLINE_IMAGES = 6;
const INLINE_TYPES = new Set([".png", ".jpg", ".jpeg", ".webp", ".gif"]);

type Overrides = Record<string, Record<string, unknown>>;
interface UiSlot { name: string; link: number | null }
interface UiNode { id: number; type: string; mode?: number; inputs?: UiSlot[]; outputs?: UiSlot[]; widgets_values?: unknown[] }
interface UiWorkflow {
	nodes: UiNode[];
	links?: [number, number, number, number, number][];
	definitions?: { subgraphs?: { id: string }[] };
}
type ApiPrompt = Record<string, { class_type: string; inputs: Record<string, unknown> }>;
type ObjectInfo = Record<string, { input: { required?: Record<string, unknown[]>; optional?: Record<string, unknown[]> } }>;
interface HistoryEntry {
	status: { status_str: string; messages: [string, Record<string, unknown>][] };
	outputs: Record<string, Record<string, { filename: string; subfolder?: string; type?: string }[]>>;
}

const FRONTEND_ONLY = /^(Reroute|Primitive|Note$|MarkdownNote$)/;
const WIDGET_TYPES = new Set(["INT", "FLOAT", "STRING", "BOOLEAN", "COMBO"]);
const SEED_CONTROLS = new Set(["fixed", "increment", "decrement", "randomize"]);

async function call(url: string, body?: unknown, timeoutMs = 10_000): Promise<unknown> {
	const res = await fetch(url, {
		method: body === undefined ? "GET" : "POST",
		headers: body === undefined ? undefined : { "Content-Type": "application/json" },
		body: body === undefined ? undefined : JSON.stringify(body),
		signal: AbortSignal.timeout(timeoutMs),
	});
	const text = await res.text();
	if (!res.ok) throw new Error(`${res.status} ${text.slice(0, 2000)}`);
	return text ? JSON.parse(text) : null;
}

const isDown = async (url: string): Promise<boolean> => {
	try {
		await call(url, undefined, 3000);
		return false;
	} catch {
		return true;
	}
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Widget values by input name, in the node definition's order: the file keeps them as a bare list. */
function widgetValues(node: UiNode, def: ObjectInfo[string]): Map<string, unknown> {
	const values = node.widgets_values ?? [];
	const out = new Map<string, unknown>();
	let i = 0;
	for (const section of ["required", "optional"] as const) {
		for (const [name, spec] of Object.entries(def.input[section] ?? {})) {
			const type = Array.isArray(spec[0]) ? "COMBO" : String(spec[0]);
			if (!WIDGET_TYPES.has(type) && type !== "IMAGEUPLOAD") continue;
			if (i >= values.length) return out;
			const value = values[i++];
			if (type === "INT" && typeof values[i] === "string" && SEED_CONTROLS.has(values[i])) i++;
			if (type !== "IMAGEUPLOAD") out.set(name, value);
		}
	}
	return out;
}

/** The UI graph as an API prompt; node ids stay the UI's, so `set` can name them. */
function toApiPrompt(ui: UiWorkflow, info: ObjectInfo): ApiPrompt {
	const nodes = new Map(ui.nodes.map((n) => [n.id, n]));
	const links = new Map((ui.links ?? []).map((l) => [l[0], l] as const));
	const unknown = ui.nodes.find((n) => !info[n.type] && !FRONTEND_ONLY.test(n.type));
	if (unknown) {
		const subgraph = ui.definitions?.subgraphs?.some((s) => s.id === unknown.type);
		throw new Error(`node #${unknown.id} (${unknown.type}): ${subgraph ? "a subgraph, unwrap it in the ComfyUI UI first" : "not loaded in ComfyUI (custom node missing?)"}`);
	}
	const widgets = new Map(ui.nodes.map((n) => [n.id, info[n.type] ? widgetValues(n, info[n.type]) : new Map<string, unknown>()]));
	// Where a link really comes from: reroutes and primitives are frontend-only; a bypassed node (mode 4) hands its
	// own input of that name through.
	const source = (link: number): unknown => {
		const l = links.get(link);
		const n = l && nodes.get(l[1]);
		if (!l || !n) throw new Error(`link ${link}: its source node is missing from the workflow`);
		if (n.type === "Reroute") return n.inputs?.[0]?.link == null ? undefined : source(n.inputs[0].link);
		if (n.type.startsWith("Primitive")) return n.widgets_values?.[0];
		if (n.mode === 4) {
			const name = n.outputs?.[l[2]]?.name ?? "";
			const slot = n.inputs?.find((s) => s.name === name) ?? n.inputs?.[l[2]];
			return slot?.link == null ? widgets.get(n.id)?.get(slot?.name ?? name) : source(slot.link);
		}
		return [String(n.id), l[2]];
	};
	const prompt: ApiPrompt = {};
	for (const n of ui.nodes) {
		if (n.mode === 2 || FRONTEND_ONLY.test(n.type)) continue;
		const inputs: Record<string, unknown> = {};
		for (const slot of n.inputs ?? []) if (slot.link != null) inputs[slot.name] = source(slot.link);
		for (const [name, value] of widgets.get(n.id) ?? []) if (!(name in inputs)) inputs[name] = value;
		prompt[String(n.id)] = { class_type: n.type, inputs };
	}
	return prompt;
}

function withOverrides(prompt: ApiPrompt, base: Overrides, job: Overrides): ApiPrompt {
	const out: ApiPrompt = {};
	for (const [id, node] of Object.entries(prompt)) {
		out[id] = { class_type: node.class_type, inputs: { ...node.inputs, ...base[id], ...job[id] } };
	}
	return out;
}

function loadWorkflow(name: string, cwd: string): UiWorkflow | ApiPrompt {
	const candidates = [resolve(cwd, name), join(COMFY_DIR, "user/default/workflows", `${name}.json`)];
	const file = candidates.find((p) => existsSync(p));
	if (!file) throw new Error(`workflow not found: ${name} (looked in ${cwd} and ~/ComfyUI/user/default/workflows)`);
	return JSON.parse(readFileSync(file, "utf8"));
}

/** The reason of a refused /slots call: the server answers its error as JSON behind the status code. */
function refusal(e: unknown): string {
	const text = String(e instanceof Error ? e.message : e);
	try {
		return JSON.parse(text.slice(text.indexOf(" ") + 1)).error?.message ?? text;
	} catch {
		return text;
	}
}

async function slot(action: "save" | "restore"): Promise<{ tokens: number; seconds: number }> {
	const r = (await call(`${STRATA}/slots/0?action=${action}`, { filename: SLOT_FILE }, 300_000)) as
		{ n_saved?: number; n_restored?: number; timings: { save_ms?: number; restore_ms?: number } };
	return { tokens: r.n_saved ?? r.n_restored ?? 0, seconds: (r.timings.save_ms ?? r.timings.restore_ms ?? 0) / 1000 };
}

async function saveConversation(): Promise<string> {
	try {
		const { tokens, seconds } = await slot("save");
		return tokens >= MIN_SAVE_TOKENS
			? `conversation saved, ${tokens} tokens in ${seconds.toFixed(1)}s`
			: `conversation of ${tokens} tokens not saved: the next request reads it again`;
	} catch (e) {
		return `conversation not saved (${refusal(e)})`;
	}
}

async function loadStrata(): Promise<string> {
	try {
		await call(`${STRATA}/load`, {}, 240_000);
		return "strata loaded";
	} catch (e) {
		return `strata not loaded (${refusal(e)}): the next request loads it`;
	}
}

async function restoreConversation(): Promise<string> {
	try {
		const { tokens, seconds } = await slot("restore");
		return `conversation restored, ${tokens} tokens in ${seconds.toFixed(1)}s`;
	} catch (e) {
		return `conversation not restored (${refusal(e)}): the next request reads its prompt again`;
	}
}

async function unloadStrata(): Promise<string> {
	let loaded: boolean;
	try {
		loaded = ((await call(`${STRATA}/health`)) as { loaded: boolean }).loaded;
	} catch {
		return "strata not running";
	}
	if (!loaded) return "strata already unloaded";
	const r = (await call(`${STRATA}/unload?wait=60`, {}, 90_000)) as { status: string };
	if (r.status === "busy") throw new Error("Strata is busy with another request; call again when it is idle");
	return `strata ${r.status}`;
}

async function ensureComfy(): Promise<string> {
	if (!(await isDown(`${COMFY}/system_stats`))) return "comfy up";
	const log = openSync(COMFY_LOG, "a");
	const child = spawn(join(COMFY_DIR, ".venv/bin/python"), ["main.py", "--disable-auto-launch", "--port", "8188"], {
		cwd: COMFY_DIR, detached: true, stdio: ["ignore", log, log],
	});
	closeSync(log);
	child.unref();
	for (let s = 0; s < 180; s += 2) {
		await sleep(2000);
		if (!(await isDown(`${COMFY}/system_stats`))) return `comfy started, log ${COMFY_LOG}`;
	}
	throw new Error(`ComfyUI did not come up in 3 min; see ${COMFY_LOG}`);
}

async function freeComfy(): Promise<string> {
	await call(`${COMFY}/free`, { unload_models: true, free_memory: true });
	// ComfyUI's worker acts on those flags a moment later: the card is not free the instant /free answers.
	let freeMb = 0;
	for (let s = 0; s < 15 && freeMb < VRAM_FREE_FLOOR_MB; s++) {
		await sleep(1000);
		const stats = (await call(`${COMFY}/system_stats`)) as { devices: { vram_free: number }[] };
		freeMb = Math.round((stats.devices?.[0]?.vram_free ?? 0) / 2 ** 20);
	}
	if (freeMb >= VRAM_FREE_FLOOR_MB) return `comfy models freed, ${freeMb} MiB VRAM free`;
	try {
		execFileSync("pkill", ["-KILL", "-f", "ComfyUI/.venv/bin/python main.py"]);
	} catch {}
	return `comfy kept ${freeMb} MiB VRAM after /free: process ended, the next call starts it again`;
}

function refusalText(prompt: ApiPrompt, body: { error?: { type?: string; message?: string }; node_errors?: Record<string, { errors?: { message?: string; details?: string }[]; class_type?: string }> }): string {
	const lines = [`ComfyUI refused the prompt: ${body.error?.message ?? ""} (${body.error?.type ?? "?"})`];
	for (const [id, err] of Object.entries(body.node_errors ?? {})) {
		const what = (err.errors ?? []).map((e) => `${e.message}${e.details ? `: ${e.details}` : ""}`).join("; ");
		lines.push(`  #${id} ${err.class_type ?? ""}: ${what}`, `  its inputs: ${JSON.stringify(prompt[id]?.inputs ?? {})}`);
	}
	return lines.join("\n");
}

async function runJob(prompt: ApiPrompt, deadline: number, signal: AbortSignal | undefined, tick: () => void): Promise<{ text: string; files: string[] }> {
	let id: string;
	try {
		({ prompt_id: id } = (await call(`${COMFY}/prompt`, { prompt }, 30_000)) as { prompt_id: string });
	} catch (e) {
		const text = String(e.message ?? e);
		try {
			return { text: refusalText(prompt, JSON.parse(text.slice(text.indexOf(" ") + 1))), files: [] };
		} catch {
			throw e;
		}
	}
	for (;;) {
		if (signal?.aborted) {
		await call(`${COMFY}/interrupt`, {}).catch(() => {});
		await call(`${COMFY}/free`, { unload_models: true, free_memory: true }).catch(() => {});
			throw new Error("aborted: the render was interrupted, its models freed");
		}
		const entry = ((await call(`${COMFY}/history/${id}`)) as Record<string, HistoryEntry> | null)?.[id];
		if (entry) {
			const files = [...new Set(Object.values(entry.outputs ?? {}).flatMap((o) =>
				Object.values(o).flat().filter((f) => f && typeof f.filename === "string")
					.map((f) => join(COMFY_DIR, f.type === "temp" ? "temp" : "output", f.subfolder ?? "", f.filename))))];
			const errors = (entry.status.messages ?? []).filter(([kind]) => kind === "execution_error")
				.map(([, d]) => `#${d.node_id} ${d.node_type}: ${d.exception_message}`);
			return { text: errors.length ? `error:\n  ${errors.join("\n  ")}` : "done", files };
		}
		if (Date.now() > deadline) {
			await call(`${COMFY}/interrupt`, {}).catch(() => {});
			throw new Error(`no result before the timeout; interrupted`);
		}
		await sleep(2000);
		tick();
	}
}

function imageContent(files: string[]) {
	return files.filter((f) => INLINE_TYPES.has(extname(f).toLowerCase())).slice(0, INLINE_IMAGES)
		.map((f) => ({ type: "image" as const, data: readFileSync(f).toString("base64"), mimeType: `image/${extname(f).slice(1).replace("jpg", "jpeg")}` }));
}

// One GPU: calls queue up here instead of racing each other when the model issues several in one turn.
let serial: Promise<unknown> = Promise.resolve();
function oneAtATime<T>(run: () => Promise<T>): Promise<T> {
	const next = serial.then(run, run);
	serial = next.catch(() => {});
	return next;
}

const comfyTool = defineTool({
	name: "comfy",
	label: "ComfyUI",
	description:
		"Run ComfyUI workflows on the GPU the Strata LLM server shares, and return the output files, images inlined. " +
		"The call is the whole batch: the LLM's conversation goes to a file (POST /slots/0?action=save), the model is " +
		"unloaded (POST /unload: ~22 GB VRAM and ~52 GB RAM free in a second), ComfyUI runs every job and drops its " +
		"models (POST /free; it stays up at ~0.5 GB VRAM), the model loads again (POST /load) and the conversation is " +
		"restored from that file (POST /slots/0?action=restore), so the next request reads only its new tokens instead " +
		"of the whole prompt. workflow: a saved UI workflow by name or path (default " +
		"dir ~/ComfyUI/user/default/workflows) or an API-format prompt; node ids are the UI's. set: {nodeId: {input: " +
		"value}} for every job. jobs: one entry per queued prompt, each a {nodeId: {input: value}} of its own, e.g. " +
		'[{"484": {"prompt": "a fox"}}, {"484": {"prompt": "an owl"}, "489": {"seed": 7}}]. A refused job returns ' +
		"ComfyUI's node_errors with the converted inputs of those nodes: bypass the node in the workflow file (mode 4) " +
		"or edit it, then call again. Files land where the workflow's Save node puts them (~/ComfyUI/output/...); " +
		"PreviewImage writes to temp/, which the next ComfyUI start wipes, so save with SaveImage. " +
		"Subgraphs are refused: unwrap them in the ComfyUI UI once.",
	promptSnippet: "Run ComfyUI image and video workflows on the shared GPU (unloads the LLM server for the run)",
	promptGuidelines: [
		"Plan a whole generation cycle before calling comfy and pass every prompt or seed of it as jobs in one call: while it runs the LLM server is unloaded, so nothing can be thought or fixed until it returns.",
		"Never call comfy together with other tools or twice in a turn.",
		"After comfy returns, look at the inlined images (for video, frames cut with ffmpeg) before showing the result to the user.",
	],
	parameters: Type.Object({
		workflow: Type.String({ description: "UI workflow name or path, or an API-format prompt file" }),
		set: Type.Optional(Type.Record(Type.String(), Type.Any(), { description: "{nodeId: {input: value}}, applied to every job" })),
		jobs: Type.Optional(Type.Array(Type.Record(Type.String(), Type.Any()), { description: "One {nodeId: {input: value}} per queued prompt; omitted: one job" })),
		timeout_min: Type.Optional(Type.Number({ minimum: 1, maximum: 480, description: "Per job; default 30" })),
	}),

	async execute(_toolCallId, params, signal, onUpdate, ctx) {
		return oneAtATime(async () => {
			const t0 = Date.now();
			const stages: string[] = [];
			const say = (text: string) => onUpdate?.({ content: [{ type: "text", text }], details: { stage: text } });
			const stage = async (text: string, run: () => Promise<string>) => {
				say(`${text}...`);
				const result = await run();
				stages.push(`${result} ${((Date.now() - t0) / 1000).toFixed(0)}s`);
				return result;
			};

			const overrides: Overrides = params.set ?? {};
			const jobs: Overrides[] = params.jobs?.length ? params.jobs : [{}];
			const timeoutMs = (params.timeout_min ?? 30) * 60_000;
			const loaded = loadWorkflow(params.workflow.replace(/^@/, ""), ctx?.cwd ?? process.cwd());
			const isUi = (w: UiWorkflow | ApiPrompt): w is UiWorkflow => Array.isArray((w as UiWorkflow).nodes);
			const saved = (await stage("saving the conversation", saveConversation)).startsWith("conversation saved");
			await stage("unloading the LLM server", unloadStrata);
			await stage("ComfyUI", ensureComfy);
			const info = isUi(loaded) ? ((await call(`${COMFY}/object_info`, undefined, 60_000)) as ObjectInfo) : {};
			const prompt = isUi(loaded) ? toApiPrompt(loaded, info) : loaded;
			say(`rendering ${jobs.length} job${jobs.length > 1 ? "s" : ""}...`);
			const results: { text: string; files: string[] }[] = [];
			for (const [i, job] of jobs.entries()) {
				const started = Date.now();
				const result = await runJob(withOverrides(prompt, overrides, job), started + timeoutMs, signal,
					() => say(`rendering job ${i + 1}/${jobs.length}, ${((Date.now() - started) / 1000).toFixed(0)}s`));
				results.push(result);
				if (!result.text.startsWith("done")) break;
				stages.push(`job ${i + 1} ${((Date.now() - started) / 1000).toFixed(0)}s`);
			}
			await stage("freeing ComfyUI models", freeComfy);
			if (saved) {
				await stage("loading the LLM server", loadStrata);
				await stage("restoring the conversation", restoreConversation);
			}

			const text = [
				`${stages.join("; ")}.`,
				...results.map((r, i) => `job ${i + 1}: ${r.text}${r.files.length ? `\n  ${r.files.join("\n  ")}` : ""}`),
			].join("\n");
			const files = results.flatMap((r) => r.files);
			return { content: [{ type: "text", text }, ...imageContent(files)], details: { stages, jobs: results } };
		});
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(comfyTool);
}
