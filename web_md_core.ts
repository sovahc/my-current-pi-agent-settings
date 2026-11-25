import TurndownService from 'turndown';
import { gfm } from '@joplin/turndown-plugin-gfm';

// Page furniture. Dropped inside the page, before serialization: Turndown has no
// rule for <script>/<style>, so their text survives as plain Markdown otherwise.
const CHROME_TAGS = ['script', 'style', 'noscript', 'template', 'svg', 'form', 'nav',
	'header', 'footer', 'aside', 'iframe', 'button', 'input', 'textarea', 'select', 'dialog'];

// ARIA landmarks are page furniture too, and plenty of sites mark it up with
// tables and divs instead of the semantic tags above.
const CHROME_SELECTORS = ['[role=navigation]', '[role=banner]', '[role=complementary]',
	'[role=contentinfo]', '[role=search]'];

// Everything else goes, because a table that cannot become a Markdown table is
// passed through as HTML with its attributes intact — and real pages carry ids,
// classes, inline styles and megabytes of editor metadata in there. colspan and
// rowspan are the only layout attributes Markdown can express. Nor is title:
// Turndown copies it into every link, which on a link-dense page such as
// Wikipedia roughly doubles the price of a link for hover text nobody reads.
const KEEP_ATTRIBUTES = ['href', 'src', 'alt', 'colspan', 'rowspan', 'start', 'lang'];

// Content containers, best first. The list is Readability's own positive match
// pattern (Readability.js REGEXP_POSITIVE_MATCH) turned into selectors.
const CONTAINER_SELECTORS = ['article', 'main', '[role=main]', '#content', '#main',
	'#main-content', '.main-content', '.post-content', '.entry-content', '.container', 'body'];

/**
 * Pick the content container and hand back its HTML, with every URL absolute.
 *
 * No article extraction: Readability and Turndown cannot be combined, because
 * Readability drops tables during candidate selection. On
 * wikipedia.org/wiki/Comparison_of_web_browsers it returned 3478117 chars of HTML
 * with 34 tables as an article of 328585 chars with 0 tables; with its
 * STRIP_UNLIKELYS flag off the article had 30 tables but 2560680 chars, i.e. the
 * whole page. Choosing a container by selector is dumb enough to keep tables in.
 */
export async function extractPageContent(page: any): Promise<string> {
	return page.evaluate(({ chromeTags, chromeSelectors, keepAttributes, selectors }: {
		chromeTags: string[]; chromeSelectors: string[]; keepAttributes: string[]; selectors: string[];
	}) => {
		for (const el of document.querySelectorAll(chromeTags.concat(chromeSelectors).join(','))) el.remove();

		// Turndown reads attributes verbatim (node.getAttribute('href' | 'src')) and
		// has no base-URL handling at all, so relative URLs must be resolved here —
		// and the browser has already done that arithmetic.
		for (const el of document.querySelectorAll(
			'a[href], link[href], img[src], source[src], iframe[src], video[src], audio[src]')) {
			const node = el as any;
			if (node.tagName === 'A' || node.tagName === 'LINK') {
				if (node.href) node.setAttribute('href', node.href);
			} else {
				// currentSrc: whichever candidate the browser picked out of srcset
				const url = node.currentSrc || node.src;
				if (url) node.setAttribute('src', url);
			}
		}

		for (const el of Array.from(document.querySelectorAll('*'))) {
			for (const attr of Array.from(el.attributes)) {
				if (!keepAttributes.includes(attr.name.toLowerCase())) el.removeAttribute(attr.name);
			}
		}

		const tableCount = (el: Element | null) => (el ? el.querySelectorAll('table').length : -1);
		let container: Element | null = null;
		let firstMatched: Element | null = null;
		for (const selector of selectors) {
			const el = document.querySelector(selector);
			if (!el) continue;
			firstMatched ??= el;
			// A container without tables while the page has them means the payload is
			// somewhere else, so keep looking; 'body' ends the list, so looking always ends.
			if (tableCount(el) > 0) { container = el; break; }
		}
		const root = container ?? firstMatched ?? document.body;
		return root.outerHTML;
	}, { chromeTags: CHROME_TAGS, chromeSelectors: CHROME_SELECTORS, keepAttributes: KEEP_ATTRIBUTES, selectors: CONTAINER_SELECTORS });
}

/** Content HTML from extractPageContent() → Markdown with GFM tables, links, image URLs. */
export function htmlToMarkdown(html: string): string {
	return tidyMarkdown(buildTurndownService().turndown(html));
}

function buildTurndownService(): TurndownService {
	const service = new TurndownService({
		headingStyle: 'atx', // setext's "===" underline doubles the line count of every heading
		codeBlockStyle: 'fenced',
		bulletListMarker: '-',
		// Read by @joplin/turndown-plugin-gfm (lib/turndown-plugin-gfm.cjs.js:362). Off, a
		// table that contains another table drops its own header row and keeps the inner
		// one; on, it is kept intact — as HTML, which loses nothing.
		preserveNestedTables: true,
	} as any);

	service.use(gfm);
	// Lazy-loading placeholders arrive as base64 1x1 gifs; inlined, each is tens of
	// kilobytes of context.
	service.addRule('dataUriImage', {
		filter: (node: any) => node.nodeName === 'IMG' && (node.getAttribute('src') || '').startsWith('data:'),
		replacement: () => '',
	});
	return service;
}

// Two of the four passes of tidyMarkdown() in jina-ai/reader (src/utils/markdown.ts).
// Its remaining two repair that project's own line wrapping.
function tidyMarkdown(md: string): string {
	return md
		.replace(/\n{3,}/g, '\n\n')
		.replace(/^[ \t]+/gm, '')
		.trim();
}

// pi loads every *.ts in this directory as an extension and complains when a file
// exports no factory; browser.ts carries the same empty export for this reason.
export default function (pi: unknown) {
}
