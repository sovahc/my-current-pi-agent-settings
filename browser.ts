import { chromium, type Browser } from 'playwright';

const CDP_URL = 'http://localhost:9222';
let globalBrowser: Browser | null = null;

// We store the browser instance to avoid reconnecting on every single call,
// though the connection can be dropped if the browser is restarted.

export async function getBrowserAndContext() {
	try {
		if (globalBrowser) {
			const contexts = await globalBrowser.contexts();
			if (contexts.length > 0) {
				return { browser: globalBrowser, context: contexts[0] };
			}
		}

		globalBrowser = await chromium.connectOverCDP(CDP_URL);
		const contexts = await globalBrowser.contexts();
		const context = contexts[0];
		return { browser: globalBrowser, context };
	} catch (error: any) {
		globalBrowser = null;
		throw new Error(`Failed to connect to browser at ${CDP_URL}. Make sure the browser is running with --remote-debugging-port=9222. Original error: ${error.message}`);
	}
}

export default function (pi: ExtensionAPI) {
}