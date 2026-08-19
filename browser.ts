import { chromium, type Browser } from 'playwright';
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
		return { browser: globalBrowser, context };
	} catch (error: any) {
		globalBrowser = null;
		throw new Error(`Failed to connect to browser at ${CDP_URL}. Make sure the browser is running with --remote-debugging-port=9222. Original error: ${error.message}`);
	}
}

export default function (pi: ExtensionAPI) {
}