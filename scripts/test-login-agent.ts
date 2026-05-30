/**
 * LoginAgent smoke test — runs the agent orchestration end-to-end
 * against a static HTML fixture that mimics Instagram's login layout,
 * without hitting a live model provider and without touching a real IG account.
 *
 * The test:
 *   1. Launches a Playwright chromium instance (ephemeral — no profile).
 *   2. Points it at scripts/fixtures/fake-ig-login.html (file://).
 *   3. Runs a TestLoginAgent subclass whose callLLM is scripted with a
 *      canonical happy-path sequence:
 *          click(username input) → fill_username →
 *          click(password input) → fill_password →
 *          click(Log in button)  → done
 *      No real LLM call is made.
 *   4. Asserts the fixture's form submitter recorded the expected
 *      username + password length on window.__kowalskiSubmitted.
 *   5. Confirms the LoginAgent.finaliseStatus() returned 'success'
 *      (the prompt emitted `done`).
 *
 * What this proves:
 *   - The executor substitutes credentials from config.credentials
 *     without routing them through any LLM payload (we never set an
 *     provider credentials — the scripted callLLM never reaches the network).
 *   - fill_username / fill_password type the right value into the
 *     focused field with per-character delay.
 *   - The base-class action dispatcher cleanly delegates login
 *     actions to the LoginAgent's override.
 *
 * What this doesn't cover:
 *   - 2FA / device-approval flows (page state too varied to fake).
 *   - Stuck detection (would require a real loop — covered by manual
 *     real-account testing).
 *   - The plugin-side pending-login round trip (test-plugin.ts covers
 *     the tool surface).
 *
 * Run: `npm run test:login`.
 */

import path from 'node:path';
import url from 'node:url';
import { chromium } from 'playwright';
import { GhostMouse } from '../src/main/services/GhostMouse.js';
import { HumanScroll } from '../src/main/services/HumanScroll.js';
import { ScreenshotCollector } from '../src/main/services/ScreenshotCollector.js';
import { LoginAgent, type LoginAgentConfig } from '../src/main/services/LoginAgent.js';
import type { VisionAction } from '../src/main/services/BaseVisionAgent.js';
import type { InferenceClient } from '../src/main/services/Inference.js';

const __dirname = path.dirname(url.fileURLToPath(import.meta.url));
const fixturePath = path.join(__dirname, 'fixtures', 'fake-ig-login.html');

function fail(msg: string): never {
    console.error(`❌ ${msg}`);
    process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) fail(msg);
}

const scriptedInferenceClient: InferenceClient = {
    backend: 'openclaw',
    async complete() {
        throw new Error('scripted login test should not call inference');
    },
};

/**
 * Scripted-LLM subclass. Overrides callLLM so no model-provider request is
 * ever made. The script drives a canonical happy-path login sequence;
 * the test asserts the executor dispatches each action correctly.
 */
class ScriptedLoginAgent extends LoginAgent {
    private step = 0;
    private script: Array<(elements: Map<number, { tag: string; ariaLabel: string; text: string }>) => VisionAction> = [];

    constructor(
        page: Parameters<typeof LoginAgent.prototype.constructor>[0],
        ghost: GhostMouse,
        scroll: HumanScroll,
        collector: ScreenshotCollector,
        config: LoginAgentConfig
    ) {
        super(page, ghost, scroll, collector, config);

        const findId = (
            elements: Map<number, { tag: string; ariaLabel: string; text: string }>,
            match: (el: { tag: string; ariaLabel: string; text: string }) => boolean
        ): number => {
            for (const [id, el] of elements) if (match(el)) return id;
            throw new Error('fixture assertion failed: expected element not labelled');
        };

        this.script = [
            (els) => ({
                thinking: 'Scripted: click the username input.',
                action: 'click',
                element: findId(els, (e) => /username|email|phone/i.test(e.ariaLabel)),
            }),
            () => ({
                thinking: 'Scripted: executor fills username from config.credentials.',
                action: 'fill_username' as VisionAction['action'],
            }),
            (els) => ({
                thinking: 'Scripted: click the password input.',
                action: 'click',
                element: findId(els, (e) => /password/i.test(e.ariaLabel)),
            }),
            () => ({
                thinking: 'Scripted: executor fills password from config.credentials.',
                action: 'fill_password' as VisionAction['action'],
            }),
            (els) => ({
                thinking: 'Scripted: click the Log in button.',
                action: 'click',
                element: findId(els, (e) => /^log in$/i.test(e.ariaLabel) || /^log in$/i.test(e.text)),
            }),
            () => ({
                thinking: 'Scripted: fixture submitter ran; nothing more to do.',
                action: 'done',
            }),
        ];
    }

    protected async callLLM(): Promise<VisionAction> {
        const i = this.step++;
        if (i >= this.script.length) return { thinking: 'script exhausted', action: 'done' };
        // `currentElements` is populated by captureAndDecide before callLLM.
        const els = (this as unknown as { currentElements: Map<number, { tag: string; ariaLabel: string; text: string }> }).currentElements;
        return this.script[i](els);
    }
}

async function main(): Promise<void> {
    // Hard-code the test credentials. The prompt asked for IG_USERNAME /
    // IG_PASSWORD env routing — we read those here so the test matches
    // how the real plugin plumbs them.
    process.env.IG_USERNAME = process.env.IG_USERNAME ?? 'testuser';
    process.env.IG_PASSWORD = process.env.IG_PASSWORD ?? 'testpass1234';
    const username = process.env.IG_USERNAME;
    const password = process.env.IG_PASSWORD;

    const browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    try {
        await page.goto('file://' + fixturePath, { waitUntil: 'domcontentloaded' });
        console.log('✅ fixture loaded');

        const ghost = new GhostMouse(page);
        const scroll = new HumanScroll(page);
        const collector = new ScreenshotCollector(page);

        const agent = new ScriptedLoginAgent(page, ghost, scroll, collector, {
            inferenceClient: scriptedInferenceClient,
            maxDurationMs: 30_000,
            credentials: { username, password },
            // browserProfileDir points at a path that definitely has no
            // Cookies DB — probeInstagramLogin will return
            // { logged_in: false, reason: 'no-cookie' } and the agent
            // will never flip to success via the probe. Success here
            // comes from the LLM emitting `done`.
            browserProfileDir: '/tmp/kowalski-nonexistent-' + Date.now(),
        });

        await agent.run();

        const submitted = await page.evaluate(
            () => (window as unknown as { __kowalskiSubmitted?: { username: string; passwordLength: number } }).__kowalskiSubmitted
        );
        assert(submitted, 'fixture never received a submit — check the form wiring and action script');
        assert(
            submitted.username === username,
            `fixture received wrong username: expected "${username}", got "${submitted.username}"`
        );
        assert(
            submitted.passwordLength === password.length,
            `fixture received wrong password length: expected ${password.length}, got ${submitted.passwordLength}`
        );
        console.log(`✅ fixture received username "${submitted.username}" and a ${submitted.passwordLength}-char password`);

        const status = agent.finaliseStatus();
        assert(status === 'success', `expected finaliseStatus() === 'success', got '${status}'`);
        console.log('✅ finaliseStatus returned success');

        console.log('\n🎉 login-agent smoke test passed');
    } finally {
        await context.close().catch(() => {});
        await browser.close().catch(() => {});
    }
}

main().catch((err) => {
    fail(`login-agent smoke test threw: ${err instanceof Error ? err.message : String(err)}`);
});
