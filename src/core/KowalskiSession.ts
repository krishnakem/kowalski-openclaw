/**
 * KowalskiSession — the host-supplied handle threaded through every service.
 *
 * Deviations from the Stage 1 sketch (REFACTOR_NOTES.md, bottom of file):
 *   - `runConfig` became a required object (all inner fields still optional) so
 *     callers don't have to spread `?.` through RunManager for every read.
 *   - Added `isPackaged?: boolean` — ChromiumVersionHelper used to branch on
 *     `app.isPackaged`; the plugin host may still want to nudge cache lookup.
 *     Default is false when the factory builds a session.
 *   - `browser.executablePath` kept; the Stage 1 `useCustomStealthBrowser`
 *     toggle was collapsed into "executablePath set → use it, else let
 *     Playwright decide." The Electron-only stealth-browser branch is gone.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { BrowserContext } from 'playwright';

export interface KowalskiSession {
    scratchDir: string;
    outputDir: string;
    browserProfileDir: string;

    anthropicApiKey: string;
    runConfig: {
        userName?: string;
        location?: string;
        phases?: Array<'stories' | 'feed'>;
        maxDurationMs?: number;
        // Hard per-phase caps. Each phase installs a setTimeout at its start
        // that cooperatively stops the agent when it fires, letting the
        // extractor drain and the run fall through to the next phase /
        // finalize. Defaults: 15 min stories, 30 min feed. Host-only knob
        // for now — not surfaced as a tool parameter.
        storiesTimeoutMs?: number;
        feedTimeoutMs?: number;
        // Instagram credentials for the Stage 6 agentic LoginAgent. Plumbed
        // through session.runConfig (not a global singleton) so the plugin
        // can gate on the env vars at register() time without threading a
        // new arg down the service graph. Never pass these fields into any
        // LLM payload — the LoginAgent executor reads them directly during
        // fill_username / fill_password action dispatch. If either is
        // absent, the plugin's `login` tool falls back to the Stage 5
        // headful --app window.
        igUsername?: string;
        igPassword?: string;
    };

    browser?: {
        context?: BrowserContext;
        executablePath?: string;
    };

    isPackaged?: boolean;

    events: EventEmitter;
    abortSignal: AbortSignal;
}

export interface CreateKowalskiSessionOptions {
    scratchDir?: string;
    outputDir?: string;
    browserProfileDir?: string;
    anthropicApiKey: string;
    runConfig?: KowalskiSession['runConfig'];
    browser?: KowalskiSession['browser'];
    isPackaged?: boolean;
}

export interface CreateKowalskiSessionResult {
    session: KowalskiSession;
    controller: AbortController;
}

export function createKowalskiSession(
    opts: CreateKowalskiSessionOptions
): CreateKowalskiSessionResult {
    if (!opts.anthropicApiKey) {
        throw new Error('createKowalskiSession: anthropicApiKey is required');
    }

    const base = path.join(os.tmpdir(), `kowalski-${uuidv4()}`);
    const scratchDir = opts.scratchDir ?? path.join(base, 'scratch');
    const outputDir = opts.outputDir ?? path.join(base, 'output');
    const browserProfileDir = opts.browserProfileDir ?? path.join(base, 'browser');

    for (const dir of [scratchDir, outputDir, browserProfileDir]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const controller = new AbortController();
    const session: KowalskiSession = {
        scratchDir,
        outputDir,
        browserProfileDir,
        anthropicApiKey: opts.anthropicApiKey,
        runConfig: opts.runConfig ?? {},
        browser: opts.browser,
        isPackaged: opts.isPackaged ?? false,
        events: new EventEmitter(),
        abortSignal: controller.signal,
    };

    return { session, controller };
}
