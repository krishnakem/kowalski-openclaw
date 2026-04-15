/**
 * Headful Instagram login flow.
 *
 * Opens a real Chromium window against a persistent user-data directory
 * and resolves when the user closes it. Used both by the plugin's
 * `login` tool (src/plugin/index.ts) and by `scripts/login.ts`
 * (`npm run login`) for a pre-plugin smoke-test.
 *
 * The args / userAgent / viewport are intentionally duplicated with
 * BrowserManager.launch() (which runs headless); consolidation waits on
 * the post-Stage-3 plugin once concurrent-run behavior is settled.
 */

import fs from 'node:fs';
import { chromium } from 'playwright-extra';
// @ts-ignore — stealth ships its own .d.ts but is loose-typed
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { ChromiumVersionHelper } from '../main/services/ChromiumVersionHelper.js';
import { KOWALSKI_VIEWPORT } from '../shared/viewportConfig.js';
import { probeInstagramLogin } from './cookie-probe.js';

chromium.use(StealthPlugin());

export async function runLogin(profileDir: string): Promise<void> {
    fs.mkdirSync(profileDir, { recursive: true });

    const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    console.log(`🪟 Launching Instagram login window against profile: ${profileDir}`);
    const context = await chromium.launchPersistentContext(profileDir, {
        headless: false,
        viewport: { width: KOWALSKI_VIEWPORT.width, height: KOWALSKI_VIEWPORT.height },
        deviceScaleFactor: 1,
        userAgent: ChromiumVersionHelper.generateUserAgent(),
        locale: 'en-US',
        timezoneId: systemTimezone,
        colorScheme: 'light',
        extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
        args: [
            '--app=https://www.instagram.com/',
            `--window-size=${KOWALSKI_VIEWPORT.width},${KOWALSKI_VIEWPORT.height}`,
            '--disable-extensions',
            '--disable-default-apps',
            '--no-first-run',
            '--no-default-browser-check',
            '--disable-features=TranslateUI,Translate,AutofillServerCommunication,OptimizationHints',
            '--disable-component-update',
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
        ],
        acceptDownloads: true,
    });

    // `--app` drives the initial navigation; just grab the page handle.
    const page = context.pages()[0] ?? (await context.newPage());
    void page;

    console.log('');
    console.log('👉 Log in in the Instagram login window. The window will close automatically');
    console.log('   once a valid Instagram session is detected. You can also close it');
    console.log('   manually if you want to abort.');
    console.log(`   Cookies will land under: ${profileDir}`);
    console.log('');

    const closed = new Promise<'closed'>((resolve) => {
        context.on('close', () => resolve('closed'));
    });

    const detected = new Promise<'logged-in'>((resolve) => {
        const interval = setInterval(() => {
            try {
                if (probeInstagramLogin(profileDir).logged_in === true) {
                    clearInterval(interval);
                    resolve('logged-in');
                }
            } catch {
                // ignore probe errors — cookies file may be mid-write
            }
        }, 2000);
        context.on('close', () => clearInterval(interval));
    });

    const outcome = await Promise.race([closed, detected]);
    if (outcome === 'logged-in') {
        console.log('✅ Valid Instagram session detected. Closing browser...');
        try {
            await context.close();
        } catch {
            /* ignore — already closing */
        }
    } else {
        console.log('✅ Browser closed by user. Login session persisted (if any).');
    }
}
