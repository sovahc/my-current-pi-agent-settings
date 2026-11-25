import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { spawn } from 'child_process';
import { createConnection } from 'net';

// Bypass SOCKS proxy for loopback so the CDP control connection to the local
// browser (:9222) stays direct; browser web traffic is still proxied via
// --proxy-server on the browser process itself.
process.env.NO_PROXY ??= 'localhost,127.0.0.1,::1';
process.env.no_proxy ??= 'localhost,127.0.0.1,::1';

const CDP_URL = 'http://localhost:9222';
const CDP_PORT = 9222;
const BROWSER_BIN = '/opt/brave.com/brave-origin-nightly/brave';
const BROWSER_ARGS = [
	'--proxy-server=socks5://127.0.0.1:1080',
	'--remote-debugging-port=9222',
	'--remote-debugging-address=127.0.0.1',
	'--user-data-dir=/home/cat/.config/BraveSoftware/Brave-Origin-Nightly',
];

let globalBrowser: Browser | null = null;

function isPortOpen(port: number, host = '127.0.0.1'): Promise<boolean> {
	return new Promise((resolve) => {
		const socket = createConnection({ port, host });
		socket.once('connect', () => { socket.destroy(); resolve(true); });
		socket.once('error', () => resolve(false));
	});
}

async function waitForPort(port: number, timeoutMs = 15000): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (await isPortOpen(port)) return true;
		await new Promise(r => setTimeout(r, 500));
	}
	return false;
}

function launchBrowser(): void {
	const child = spawn(BROWSER_BIN, BROWSER_ARGS, { detached: true, stdio: 'ignore' });
	child.unref();
}

// We store the browser instance to avoid reconnecting on every single call,
// though the connection can be dropped if the browser is restarted.

/**
 * Open a tab without bringing it in front of the user. context.newPage() creates
 * the tab and activates it, so every tool call flashes a tab over whatever is on
 * screen; Target.createTarget({background:true}) is the Ctrl+Click path, and
 * Playwright 1.59.1 has no equivalent option on newPage.
 *
 * What is verified here: the tab loads, navigates, evaluates and closes through the
 * Playwright handle. What is not: whether Brave really leaves it unactivated — CDP
 * cannot tell us (Extensions.getActiveTargets is absent, and Playwright enables
 * Emulation.setFocusEmulationEnabled for every page it attaches, crPage.js:418, so
 * visibilityState always reads 'visible'). Only the user can see that.
 */
export async function openBackgroundPage(context: BrowserContext): Promise<Page> {
	const browser = context.browser();
	if (!browser) return context.newPage();

	// A unique URL is how the new tab is recognised afterwards: a page's targetId is
	// not reachable from Playwright, and any other tab can appear at any moment.
	const marker = `about:blank#pi${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
	let cdp: any;
	let targetId: string | undefined;
	try {
		cdp = await browser.newBrowserCDPSession();
		({ targetId } = await cdp.send('Target.createTarget', {
			url: marker, background: true, forTab: true,
		}));

		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const page = context.pages().find(p => p.url() === marker);
			if (page) {
				await cdp.detach().catch(() => {});
				return page;
			}
			await new Promise(r => setTimeout(r, 50));
		}
	} catch { /* fall through: a visible tab beats a broken tool */ }

	if (cdp) {
		if (targetId) await cdp.send('Target.closeTarget', { targetId }).catch(() => {});
		await cdp.detach().catch(() => {});
	}
	return context.newPage();
}

export async function getBrowserAndContext() {
	try {
		if (globalBrowser) {
			const contexts = await globalBrowser.contexts();
			if (contexts.length > 0) {
				return { browser: globalBrowser, context: contexts[0] };
			}
		}

		// Start browser if the CDP port isn't open yet
		if (!await isPortOpen(CDP_PORT)) {
			launchBrowser();
			if (!await waitForPort(CDP_PORT)) {
				throw new Error('Browser failed to start within timeout (port 9222)');
			}
		}

		globalBrowser = await chromium.connectOverCDP(CDP_URL);
		const contexts = await globalBrowser.contexts();
		const context = contexts[0];
		// Dialogs on pages without a subscription (our own browser tabs) trigger
		// Playwright's server-side auto-close, which is unguarded in 1.59.1 and
		// crashes the agent on the "No dialog is showing" race. A context-level
		// subscription makes the dispatcher claim every dialog, disabling the
		// auto-close; foreign dialogs are then left for the user to click.
		context.on('dialog', () => {});
		return { browser: globalBrowser, context };
	} catch (error: any) {
		globalBrowser = null;
		throw new Error(`Failed to connect to browser at ${CDP_URL}. Make sure the browser is running with --remote-debugging-port=9222. Original error: ${error.message}`);
	}
}

export default function (pi: ExtensionAPI) {
}