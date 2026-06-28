/**
 * KowalskiSession — the host-supplied handle threaded through every service.
 *
 * The OpenClaw plugin host owns durable paths, inference, run config, and
 * cancellation. Services receive this object instead of reading global app
 * state, which keeps concurrent or future multi-session wiring tractable.
 */

import { EventEmitter } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { BrowserContext } from 'playwright';
import type { InferenceClient } from '../main/services/Inference.js';

export interface KowalskiSession {
    scratchDir: string;
    outputDir: string;
    browserProfileDir: string;

    inferenceClient: InferenceClient;
    runConfig: {
        userName?: string;
        location?: string;
        phases?: Array<'stories' | 'feed'>;
        maxDurationMs?: number;
        // Hard per-phase caps. Each phase installs a setTimeout at its start
        // that cooperatively stops the agent when it fires, letting the
        // extractor drain and the run fall through to the next phase /
        // finalize. start_session derives these from duration_minutes:
        // 30% stories and 70% feed/posts when both phases run.
        storiesTimeoutMs?: number;
        feedTimeoutMs?: number;
        // Instagram credentials for the Stage 6 agentic LoginAgent. These
        // are seeded only from process environment variables at plugin
        // registration time, then kept in-memory for the current login round
        // trip. Never pass these fields into tool params, tool responses,
        // logs, or any LLM payload — the LoginAgent executor reads them
        // directly during fill_username / fill_password action dispatch.
        igUsername?: string;
        igPassword?: string;
        // Optional Instagram `sessionid` cookie value, also sourced only from
        // the process environment. BrowserManager injects it directly into
        // the Playwright context; plaintext session.json injection is not
        // supported.
        igSessionId?: string;
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
    inferenceClient: InferenceClient;
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
    if (!opts.inferenceClient) {
        throw new Error('createKowalskiSession: inferenceClient is required');
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
        inferenceClient: opts.inferenceClient,
        runConfig: opts.runConfig ?? {},
        browser: opts.browser,
        isPackaged: opts.isPackaged ?? false,
        events: new EventEmitter(),
        abortSignal: controller.signal,
    };

    return { session, controller };
}
