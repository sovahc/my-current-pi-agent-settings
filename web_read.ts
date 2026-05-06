import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getBrowserAndContext } from './browser';
import { Readability } from '@mozilla/readability';
import { JSDOM } from 'jsdom';

const webReadTool = defineTool({
	name: "web_read",
	label: "Read Web Page",
	description: "Purpose: Extract and read the main content of a web page.",
	parameters: Type.Object({
		url: Type.String({ description: "The URL of the page to read" }),
		mode: Type.String({ description: "Extraction mode: 'text' (default) or 'structure' to get page headings", optional: true }),
		section: Type.String({ description: "The name of the section to read", optional: true }),
		maxLines: Type.Number({ description: "Maximum number of lines to return (like head -n)", optional: true }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		let page;
		try {
			const { context } = await getBrowserAndContext();
			page = await context.newPage();
			page.on('dialog', dialog => dialog.dismiss());

			await page.goto(params.url, { waitUntil: 'domcontentloaded', timeout: 15000 });

			let cleanText: string;

			if (params.section || params.mode === 'structure') {
				cleanText = await page.evaluate(({ mode, section }) => {
					if (section) {
						const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
						const targetHeading = headings.find(h => h.innerText.trim().toLowerCase().includes(section.toLowerCase()));
						if (!targetHeading) {
							const available = headings.map(h => h.innerText.trim()).join('\n');
							return `Section ${section} not found, available sections are:\n${available}`;
						}

						let content = [];
						let curr = targetHeading.nextElementSibling;
						const targetLevel = parseInt(targetHeading.tagName.substring(1));

						while (curr) {
							if (curr.tagName.match(/^H[1-6]$/)) {
								const currLevel = parseInt(curr.tagName.substring(1));
								if (currLevel <= targetLevel) break;
							}
							content.push(curr.innerText);
							curr = curr.nextElementSibling;
						}
						return content.join('\n');
					}

					if (mode === 'structure') {
						const headings = Array.from(document.querySelectorAll('h1, h2, h3, h4, h5, h6'));
						return headings.map(h => `${h.tagName.toLowerCase()}: ${h.innerText.trim()}`).join('\n');
					}
					return document.body.innerText;
				}, { mode: params.mode, section: params.section });
			} else {
				const html = await page.content();
				const dom = new JSDOM(html, { url: params.url });
				const reader = new Readability(dom.window.document);
				const article = reader.parse();

				cleanText = article 
					? new JSDOM(article.content).window.document.body.textContent 
					: (await page.evaluate(() => document.body.innerText));
			}

			let result = cleanText;
			if (params.maxLines != null && params.maxLines > 0) {
				const lines = cleanText.split('\n').filter(line => line.trim().length > 0);
				result = lines.slice(0, params.maxLines).join('\n');
			}
			return {
				content: [{
					type: "text",
					text: result
				}]
			};
		} catch (error: any) {
			return { content: [{ type: "text", text: `Error: ${error.message}` }] };
		} finally {
			if (page) {
				await page.close();
			}
		}
	},
});

export default function (pi: ExtensionAPI) {
	pi.registerTool(webReadTool);
}
