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

chromium.use(StealthPlugin());

export async function runLogin(profileDir: string): Promise<void> {
    fs.mkdirSync(profileDir, { recursive: true });

    const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

    console.log(`🪟 Launching headful Chromium against profile: ${profileDir}`);
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
            '--disable-blink-features=AutomationControlled',
            '--disable-infobars',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
        ],
        acceptDownloads: true,
    });

    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' }).catch(() => {
        console.warn('⚠️ Initial navigation slow, the window is still open — proceed anyway.');
    });

    console.log('');
    console.log("👉 Log in in the browser window, then close it when you're done.");
    console.log(`   Cookies will land under: ${profileDir}`);
    console.log('');

    await new Promise<void>((resolve) => context.on('close', () => resolve()));
    console.log('✅ Browser closed. Login session persisted.');
}
