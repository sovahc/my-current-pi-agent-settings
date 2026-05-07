import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getBrowserAndContext } from './browser';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

// Hash alphabet - excludes ambiguous chars (D/G/I/L/O), hex digits, vowels
const HASH_ALPHABET = "ZPMQVRWSNKTXJBYH";

function hashLine(text: string): string {
	let h = 5381;
	for (let i = 0; i < text.length; i++) {
		h = ((h << 5) + h + text.charCodeAt(i)) | 0;
	}
	const c1 = HASH_ALPHABET[Math.abs(h) % HASH_ALPHABET.length];
	const c2 = HASH_ALPHABET[Math.floor(Math.abs(h) / HASH_ALPHABET.length) % HASH_ALPHABET.length];
	return `${c1}${c2}`;
}

async function getCleanLines(page: any, url: string): Promise<string[]> {
	try {
		const html = await page.content();
		const dom = new JSDOM(html, { url });
		const reader = new Readability(dom.window.document);
		const article = reader.parse();
		if (article) {
			const textDom = new JSDOM(article.content).window.document.body;
			return textDom.textContent.split('\n')
				.map(l => l.trim().replace(/\s+/g, ' '))
				.filter(l => l.length > 0);
		}
	} catch { /* fallback to innerText */ }

	const innerText = await page.evaluate(() => document.body.innerText);
	return innerText.split('\n')
		.map(l => l.trim().replace(/\s+/g, ' '))
		.filter(l => l.length > 0);
}

const webReadTool = defineTool({
	name: "web_read",
	label: "Web Read",
	description: `Read a web page as text with line numbers and hash anchors. 
Like the local read tool but for URLs. Supports offset/limit for chunked reading.
Returns clean text lines in LINE#HASH format that can be used to reference specific content.`,
	parameters: Type.Object({
		url: Type.String({ description: "The URL of the page to read" }),
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
			page = await context.newPage();
			page.on('dialog', dialog => dialog.dismiss());

			await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 15000 });

			const title = await page.title();
		const lines = await getCleanLines(page, params.url);

			if (lines.length === 0) {
				return { content: [{ type: "text", text: `URL: ${params.url}\nWarning: No text content extracted from this page.` }] };
			}

			const startIdx = Math.max(0, offset - 1);
			const endIdx = Math.min(lines.length, startIdx + limit);
			const sliced = lines.slice(startIdx, endIdx);

			let output = `URL: ${params.url}`;
			if (title) output += `\nTitle: ${title}`;
			output += '\n';

			for (let i = 0; i < sliced.length; i++) {
				const lineNum = startIdx + i + 1;
				const hash = hashLine(sliced[i]);
				output += `${lineNum}#${hash}:${sliced[i]}\n`;
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

const webGrepTool = defineTool({
	name: "web_grep",
	label: "Web Grep",
	description: `Search a web page for matching lines. Returns line numbers, hash anchors and context around matches.
Like grep but for URLs. Pattern is case-insensitive substring match.`,
	parameters: Type.Object({
		url: Type.String({ description: "The URL of the page to search" }),
		pattern: Type.String({ description: "Text pattern to search for (case-insensitive)" }),
		context: Type.Optional(Type.Number({
			description: "Number of context lines before/after each match. Default: 1",
			minimum: 0,
			maximum: 20
		})),
		maxResults: Type.Optional(Type.Number({
			description: "Maximum number of matches to return. Default: 50",
			minimum: 1,
			maximum: 200
		}))
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		let page;
		try {
			const contextLines = params.context ?? 1;
			const maxResults = params.maxResults ?? 50;

			const { context } = await getBrowserAndContext();
			page = await context.newPage();
			page.on('dialog', dialog => dialog.dismiss());

			await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 15000 });

			const title = await page.title();
		const lines = await getCleanLines(page, params.url);

			// Find matching line indices (0-based)
			const matches: Array<{ index: number; line: string }> = [];
			const patternLower = params.pattern.toLowerCase();
			
			for (let i = 0; i < lines.length && matches.length < maxResults * 3; i++) {
				if (lines[i].toLowerCase().includes(patternLower)) {
					matches.push({ index: i, line: lines[i] });
				}
			}

			if (matches.length === 0) {
				return { content: [{ type: "text", text: `URL: ${params.url}\nNo matches found for pattern "${params.pattern}".` }] };
			}

			let output = `URL: ${params.url}`;
			if (title) output += `\nTitle: ${title}`;
			output += `\nMatches for "${params.pattern}" in ${lines.length} lines:\n`;

			const shown = matches.slice(0, maxResults);

			for (const match of shown) {
				const lineNum = match.index + 1;
				const hash = hashLine(match.line);

				// Context before
				if (contextLines > 0 && match.index > 0) {
					const ctxStart = Math.max(0, match.index - contextLines);
					for (let i = ctxStart; i < match.index; i++) {
						output += `${i + 1}#${hashLine(lines[i])}:${lines[i]}\n`;
					}
				}

				// Match line highlighted
				output += `**${lineNum}#${hash}:${match.line}**\n`;

				// Context after
				if (contextLines > 0 && match.index < lines.length - 1) {
					const ctxEnd = Math.min(lines.length, match.index + contextLines + 1);
					for (let i = match.index + 1; i < ctxEnd; i++) {
						output += `${i + 1}#${hashLine(lines[i])}:${lines[i]}\n`;
					}
				}

				output += '\n';
			}

			if (matches.length > maxResults) {
				output += `[Showing ${maxResults} of ${matches.length} matches. Use maxResults to see more.]`;
			} else {
				output += `[Total: ${matches.length} match(es).]`;
			}

			return { content: [{ type: "text", text: output.trim() }] };

		} catch (error: any) {
			return { content: [{ type: "text", text: `Error grepping ${params.url}: ${error.message}` }] };
		} finally {
			if (page) await page.close();
		}
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(webReadTool);
	pi.registerTool(webGrepTool);
}
