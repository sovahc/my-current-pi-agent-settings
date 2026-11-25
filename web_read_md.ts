import { Type } from "@mariozechner/pi-ai";
import { DEFAULT_MAX_BYTES, defineTool, formatSize, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import fs from 'fs';
import type { Download, Page, Response } from 'playwright';
import { getBrowserAndContext, openBackgroundPage } from './browser';
import { extractPageContent, htmlToMarkdown } from './web_md_core';

// Image types the framework inlines without converting (pi-coding-agent utils/image-process.js:7).
// normalizeToolResultImages hands back a block it could not convert (utils/tool-result-images.js:33),
// and an image the provider rejects then poisons every later request of the session, so the rest
// is refused here instead of passed on.
const INLINABLE_IMAGE_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

// Guards against an absurd download; what actually reaches the model is resized by the framework
// (core/agent-session.js:422).
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

// Download.contentType() does not exist in Playwright 1.59.1 and the download object carries no
// content type of its own. The extension Chromium named the file with comes from the header it
// read, so that is as close as this gets; an unknown extension is treated as text.
const DOWNLOADED_TYPES: Record<string, string> = {
	json: 'application/json', ndjson: 'application/x-ndjson', jsonl: 'application/x-ndjson',
	csv: 'text/csv', tsv: 'text/tab-separated-values', txt: 'text/plain',
};

const webReadMdTool = defineTool({
	name: "web_read_md",
	label: "Web Read MD",
	description: `Read a web page as Markdown.
Unlike web_read this keeps GitHub-flavored tables, hyperlinks and image URLs.
Use it for pages whose content is tables, images or link lists; use web_read for prose.
Set raw for a URL that is not an HTML page — JSON, CSV/TSV, XML, NDJSON, plain text — and it returns the body verbatim; raw on an image URL returns the image itself.
Supports offset/limit for chunked reading.`,
	parameters: Type.Object({
		url: Type.String({ description: "The URL of the page to read" }),
		raw: Type.Optional(Type.Boolean({
			description: `Return the response body verbatim, with no Markdown conversion. Use for URLs that are not HTML pages: JSON, CSV/TSV, XML, NDJSON, plain text. JSON is re-indented so that offset/limit can page through minified API output. image/png, image/jpeg, image/gif and image/webp are returned as an image attachment; any other binary type is refused with its Content-Type.`,
		})),
		offset: Type.Optional(Type.Number({
			description: "Line number to start reading from (1-indexed). Default: 1",
			minimum: 1
		})),
		limit: Type.Optional(Type.Number({
			description: "Maximum number of lines to return. Default: 200",
			minimum: 1,
			maximum: 500
		})),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		let page;
		try {
			const offset = params.offset ?? 1;
			const limit = params.limit ?? 200;

			const { context } = await getBrowserAndContext();
			page = await openBackgroundPage(context);
			page.on('dialog', dialog => { dialog.dismiss().catch(() => {}); }); // dismiss rejects with "No dialog is showing" if the browser already closed the dialog (CDP race) — harmless

			// Armed before the navigation: a body the browser will not display (text/csv,
			// application/octet-stream) turns into a download, and the event can arrive either
			// before or after the goto() it caused.
			const downloaded = params.raw ? onDownload(page) : null;

			let response: Response | null = null;
			let gotoFailure = '';
			try {
				response = await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
			} catch (error: any) {
				// "Download is starting" is the one failure raw mode can still read through: the
				// saved file is the same bytes the response would have carried.
				if (!params.raw) throw error;
				gotoFailure = error.message.split('\n')[0];
			}

			const title = await page.title();

			if (params.raw) {
				const body = await readRawBody(page, response, downloaded, gotoFailure);
				return formatRawResult(params.url, title, body, offset, limit);
			}

			const html = await extractPageContent(page);

			const lines = htmlToMarkdown(html).split('\n');

			const startIdx = Math.max(0, offset - 1);
			const endIdx = Math.min(lines.length, startIdx + limit);
			const sliced = lines.slice(startIdx, endIdx);

			let output = `URL: ${params.url}`;
			if (title) output += `\nTitle: ${title}`;
			output += '\n\n';

			for (let i = 0; i < sliced.length; i++) {
				output += `${sliced[i]}\n`;
			}

			if (endIdx < lines.length) {
				output += `\n[Showing lines ${offset}-${endIdx} of ${lines.length}. Use offset=${endIdx + 1} to continue.]`;
			} else if (startIdx > 0) {
				output += `\n[Showing lines ${offset}-${endIdx} of ${lines.length}. Total: ${lines.length} lines.]`;
			}

			return { content: [{ type: "text", text: output.trim() }] };

		} catch (error: any) {
			return { content: [{ type: "text", text: `Error reading ${params.url}: ${error.message}` }] };
		} finally {
			if (page) await page.close();
		}
	},
});

type RawBody = { contentType: string; body: Buffer; note?: string };

/**
 * The body as the browser received it — no viewer markup in the way, and nothing escaped:
 * Chromium shows JSON, CSV and text in documents of its own, which Turndown then serialises
 * with `\_` in the keys and tidyMarkdown() then flattens by stripping every leading indent.
 *
 * Re-fetching goes through the page, never through context.request: fetch.js:482 of
 * playwright-core takes the proxy from the launch options, while this browser gets its proxy
 * from --proxy-server on the spawned process (browser.ts:15), so an APIRequest would leave the
 * SOCKS proxy and the session cookies behind.
 */
async function readRawBody(page: Page, response: Response | null, downloaded: Promise<Download> | null, gotoFailure: string): Promise<RawBody> {
	if (!response) {
		const download = downloaded ? await raceTimeout(downloaded, 3000) : null;
		if (!download) throw new Error(gotoFailure || 'the browser neither displayed nor downloaded this response');
		const file = await download.path();
		if (!file) throw new Error(`the browser did not save ${download.suggestedFilename()}`);
		const body = await fs.promises.readFile(file);
		const name = download.suggestedFilename();
		await download.delete().catch(() => {});
		return { contentType: DOWNLOADED_TYPES[extensionOf(name)] ?? 'unknown', body, note: `downloaded as ${name}` };
	}

	try {
		return { contentType: mediaType(response.headers()['content-type']), body: await response.body() };
	} catch {
		// Evicted from the browser cache before it was asked for. Same origin, same proxy.
		const refetched = await page.evaluate(async (href: string) => {
			const res = await fetch(href);
			const bytes = new Uint8Array(await res.arrayBuffer());
			let binary = '';
			for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode(...bytes.subarray(i, i + 8192));
			return { contentType: res.headers.get('content-type') ?? '', base64: btoa(binary) };
		}, response.url());
		return { contentType: mediaType(refetched.contentType), body: Buffer.from(refetched.base64, 'base64'), note: 'refetched' };
	}
}

// Minified API JSON is one line, which no offset/limit can page through, so re-indenting is what
// makes the slicing usable at all. tidyMarkdown() in web_md_core.ts cannot be reused for it:
// one of its passes is /^[ \t]+/gm, which removes the indentation being added here.
function rawText(body: Buffer, contentType: string): string {
	const text = body.toString('utf-8').replace(/\r\n?/g, '\n');
	if (!contentType.includes('json') && !/^\s*[[{]/.test(text)) return text;
	try {
		return JSON.stringify(JSON.parse(text), null, 2);
	} catch {
		return text;
	}
}

// The read tool's own budget (core/tools/truncate.js:11). A slice being short in lines is not the
// same as it being small: one CSV row or one HTML line can be 200KB on its own.
function fitBudget(lines: string[], maxBytes: number): string[] {
	let bytes = 0;
	const kept: string[] = [];
	for (const line of lines) {
		bytes += Buffer.byteLength(line, 'utf-8') + 1; // the newline the line is printed with
		if (bytes > maxBytes) break;
		kept.push(line);
	}
	return kept;
}

async function formatRawResult(url: string, title: string, body: RawBody, offset: number, limit: number) {
	const { contentType, body: bytes, note } = body;
	let head = `URL: ${url}`;
	if (title) head += `\nTitle: ${title}`; // on an image URL this is the viewer's "icon.png (48×48)"
	head += `\nContent-Type: ${contentType || 'unknown'} (${formatSize(bytes.length)}${note ? `, ${note}` : ''})`;

	if (INLINABLE_IMAGE_TYPES.has(contentType)) {
		if (bytes.length > MAX_IMAGE_BYTES) {
			return { content: [{ type: 'text', text: `${head}\n\n[Image over ${formatSize(MAX_IMAGE_BYTES)} is not inlined. Fetch it with bash instead.]` }] };
		}
		return {
			content: [
				{ type: 'text', text: head },
				{ type: 'image', data: bytes.toString('base64'), mimeType: contentType },
			],
		};
	}

	if (contentType.startsWith('image/')) {
		return { content: [{ type: 'text', text: `${head}\n\n[Image not inlined; only ${[...INLINABLE_IMAGE_TYPES].join(', ')} are.]` }] };
	}
	if (bytes.length === 0) {
		return { content: [{ type: 'text', text: `${head}\n\n[Empty response body]` }] };
	}
	if (bytes.includes(0)) {
		return { content: [{ type: 'text', text: `${head}\n\n[Binary body is not returned. Fetch it with bash instead.]` }] };
	}

	const lines = rawText(bytes, contentType).split('\n');
	const startIdx = Math.max(0, offset - 1);
	const endIdx = Math.min(lines.length, startIdx + limit);
	const requested = lines.slice(startIdx, endIdx);

	if (requested.length === 0) {
		return { content: [{ type: 'text', text: `${head}\n\n[Offset ${offset} is past the end of the body: ${lines.length} lines.]` }] };
	}

	const kept = fitBudget(requested, DEFAULT_MAX_BYTES);
	if (kept.length === 0) {
		return { content: [{ type: 'text', text: `${head}\n\n[The line at offset ${offset} is ${formatSize(Buffer.byteLength(requested[0], 'utf-8'))}, over the ${formatSize(DEFAULT_MAX_BYTES)} output budget. Fetch the body with bash instead.]` }] };
	}

	const shown = startIdx + kept.length;
	let output = `${head}\n\n${kept.join('\n')}`;
	if (kept.length < requested.length) {
		output += `\n\n[Showing lines ${offset}-${shown} of ${lines.length}, stopped by the ${formatSize(DEFAULT_MAX_BYTES)} output budget. Use offset=${shown + 1} to continue.]`;
	} else if (endIdx < lines.length) {
		output += `\n\n[Showing lines ${offset}-${shown} of ${lines.length}. Use offset=${shown + 1} to continue.]`;
	} else if (startIdx > 0) {
		output += `\n\n[Showing lines ${offset}-${shown} of ${lines.length}. Total: ${lines.length} lines.]`;
	}
	return { content: [{ type: 'text', text: output }] };
}

function mediaType(contentType: string | undefined): string {
	return (contentType ?? '').split(';')[0].trim().toLowerCase();
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf('.');
	return dot < 0 ? '' : name.slice(dot + 1).toLowerCase();
}

function onDownload(page: Page): Promise<Download> {
	let started!: (download: Download) => void;
	const promise = new Promise<Download>(resolve => { started = resolve; });
	page.on('download', started);
	return promise;
}

function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
	return Promise.race([promise, new Promise<null>(resolve => setTimeout(() => resolve(null), ms))]);
}

export default function (pi: ExtensionAPI) {
	pi.registerTool(webReadMdTool);
}
