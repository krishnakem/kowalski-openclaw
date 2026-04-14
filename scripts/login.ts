/**
 * One-shot headful Instagram login.
 *
 * Opens a real Chromium window against a persistent user-data directory so the
 * cookies dropped by Instagram survive into subsequent (headless) runs. The
 * core launch logic is exported so Stage 3 can lift it almost verbatim into the
 * OpenClaw plugin's `login` tool.
 *
 * Usage:
 *   npm run login
 *   KOWALSKI_PROFILE_DIR=/custom/path npm run login
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-extra';
// @ts-ignore — stealth ships its own .d.ts but is loose-typed
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { ChromiumVersionHelper } from '../src/main/services/ChromiumVersionHelper.js';
import { KOWALSKI_VIEWPORT } from '../src/shared/viewportConfig.js';

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

    const page = context.pages()[0] ?? await context.newPage();
    await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' }).catch(() => {
        console.warn('⚠️ Initial navigation slow, the window is still open — proceed anyway.');
    });

    console.log('');
    console.log('👉 Log in in the browser window, then close it when you\'re done.');
    console.log(`   Cookies will land under: ${profileDir}`);
    console.log('');

    await new Promise<void>(resolve => context.on('close', () => resolve()));
    console.log('✅ Browser closed. Login session persisted.');
}

// Run when invoked directly (npm run login / tsx scripts/login.ts).
const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisModulePath = fileURLToPath(import.meta.url);
if (invokedPath === thisModulePath) {
    const profileDir = process.env.KOWALSKI_PROFILE_DIR
        ?? path.join(os.homedir(), '.kowalski', 'browser');
    runLogin(profileDir).then(() => process.exit(0)).catch(err => {
        console.error('❌ Login failed:', err);
        process.exit(1);
    });
}
