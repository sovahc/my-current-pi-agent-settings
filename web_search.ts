import { Type } from "@mariozechner/pi-ai";
import { defineTool, type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { getBrowserAndContext } from './browser';

const SEARCH_ENGINES: Record<string, { url: string; domain: string; forbiddenDomains?: string[] }> = {
	google: {
		url: 'https://www.google.com/search?q=',
		domain: 'google',
		forbiddenDomains: ['youtube.com', 'youtu.be'],
	},
	brave: {
		url: 'https://search.brave.com/search?q=',
		domain: 'brave',
	},
	duckduckgo: {
		url: 'https://duckduckgo.com/html/?q=',
		domain: 'duckduckgo',
	},
};

const webSearchTool = defineTool({
	name: "web_search",
	label: "Web Search",
	description: "Search the web using a specified search engine",
	parameters: Type.Object({
		query: Type.String({ description: "The search query" }),
		engine: Type.String({ description: "The search engine to use (e.g., 'google', 'brave')" }),
		maxResults: Type.Number({ description: "Maximum number of results to return", default: 5 }),
	}),

	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		let page;
		try {
			if (!params.query) {
				return { content: [{ type: "text", text: "Please provide a 'query' for searching." }] };
			}

			if (!params.engine || !SEARCH_ENGINES[params.engine]) {
				return { content: [{ type: "text", text: `Please specify a valid engine. Available: ${Object.keys(SEARCH_ENGINES).join(', ')}` }] };
			}

			const { context } = await getBrowserAndContext();
			const config = SEARCH_ENGINES[params.engine];

			page = await context.newPage();
			page.on('dialog', dialog => dialog.dismiss());

			const searchUrl = `${config.url}${encodeURIComponent(params.query)}`;
			await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 15000 });

			const maxResults = params.maxResults ?? 5;
			const text = await page.evaluate(({ domain, forbiddenDomains, maxResults }) => {
				function getDepth(el) {
					let depth = 0;
					while (el.parentElement) { depth++; el = el.parentElement; }
					return depth;
				}

				const allLinks = Array.from(document.querySelectorAll('a'))
					.filter(l => l.href && l.href.startsWith('http'));

				if (allLinks.length < 10) return "CAPTCHA detected, use another search engine";

				const filteredLinks = allLinks.filter(l => {
					const isInternal = l.href.includes(domain);
					const isForbidden = forbiddenDomains?.some(d => l.href.includes(d));
					return !isInternal && !isForbidden;
				});

				const depthCounts = {};
				filteredLinks.forEach(l => { const d = getDepth(l); depthCounts[d] = (depthCounts[d] || 0) + 1; });
				const linkDepth = Object.keys(depthCounts).reduce((a, b) =>
					depthCounts[Number(a)] > depthCounts[Number(b)] ? a : b, null);

				let resultLinks = filteredLinks.filter(l => getDepth(l) === Number(linkDepth));
				if (resultLinks.length < 1) return "No results";

				const firstLink = resultLinks[0];
				const lastLink = resultLinks[resultLinks.length - 1];
				const linkSet = new Set(resultLinks);

				let start = false;
				let stop = false;
				const knownDepths = new Set();

				let index = 1;
				let result = "";
				let linkText = "";
				let descriptionText = '';

				const reddit = /\d+\s+posts/i;
				const youtube = /YouTube ·/i;

				for (const el of document.querySelectorAll('*')) {
					if (el === firstLink) start = true;
					if (el === lastLink) stop = true;

					if (!start) continue;
					
					const d = getDepth(el);
					
					const isLink = linkSet.has(el);
					const shouldStopAndBreak = stop && !knownDepths.has(d);

					if ((isLink || shouldStopAndBreak) && descriptionText.length > 0) {
						result += `${linkText}\n${descriptionText}\n\n`;
						descriptionText = '';
						index += 1;
					}

					if (shouldStopAndBreak) break;

					knownDepths.add(d);

					if (isLink) {
						if (index > maxResults) break;
						linkText = `## ${index}. ${el.href}\n`;
					} else {
						if(el.tagName == 'SCRIPT' || el.tagName == 'STYLE') continue; // Hi, Google!
						
						const t = el.innerText?.trim();
						if(!t) continue;
						
						if(t.includes('http://') || t.includes('https://')) continue;
						if(reddit.test(t)) continue; // Hi, Reddit!
						if(youtube.test(t)) continue; // Hi, Google, again!

						if(t.length > descriptionText.length) {
							descriptionText = t.replace(/(...)?\s*Read more$/i, '');
						}
					}
				}

				if (descriptionText.length > 0) {
					result += `${descriptionText}\n\n`;
				}

				const finalResult = result.trim();
				return finalResult || "No results";
			}, { ...config, maxResults });

			const engineName = params.engine.charAt(0).toUpperCase() + params.engine.slice(1);
			const header = `### ${engineName} search: "${params.query}"\n\n`;

			return {
				content: [{
					type: "text",
					text: `${header}${text}`
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
	pi.registerTool(webSearchTool);
}
