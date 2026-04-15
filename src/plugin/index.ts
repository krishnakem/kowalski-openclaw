/**
 * OpenClaw plugin entrypoint for Kowalski.
 *
 * Exposes six tools that drive the Kowalski pipeline: start_session,
 * login, run_digest, get_session_status, reset_memory, end_session.
 * See REFACTOR_NOTES.md › Stage 3 for the design rationale (why
 * run_digest is a single blocking tool, why this uses the plain
 * default-export plugin shape instead of `definePluginEntry`, etc.).
 *
 * The module is loaded once per gateway boot and `register(api)` is
 * called exactly once. All per-session state lives in the `sessions`
 * map captured in module scope.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { v4 as uuidv4 } from 'uuid';
import type { BrowserContext, Page } from 'playwright';

import { createKowalskiSession } from '../core/KowalskiSession.js';
import { BrowserManager } from '../main/services/BrowserManager.js';
import { RunManager } from '../main/services/RunManager.js';
import { UsageService } from '../main/services/UsageService.js';
import { GhostMouse } from '../main/services/GhostMouse.js';
import { HumanScroll } from '../main/services/HumanScroll.js';
import { ScreenshotCollector } from '../main/services/ScreenshotCollector.js';
import {
    LoginAgent,
    makeLoginRunDir,
    type LoginPendingStatus,
} from '../main/services/LoginAgent.js';
import { runLogin } from './login-flow.js';
import { probeInstagramLogin } from './cookie-probe.js';
import {
    attachEventBuffer,
    createRegistry,
    type SessionEntry,
} from './session-registry.js';

// ---------------------------------------------------------------------------
// Types kept local — the real @openclaw/plugin-sdk is a workspace-private
// package in the openclaw/openclaw monorepo and is not published to npm
// (see REFACTOR_NOTES.md › Stage 3). These shapes match what the SDK
// surfaces to plugins; at runtime the real `api` comes from OpenClaw's
// loader and is duck-typed against these interfaces.
// ---------------------------------------------------------------------------

export interface AgentToolResult {
    content: Array<{ type: 'text'; text: string }>;
    isError?: boolean;
}

export interface PluginTool {
    name: string;
    description: string;
    parameters: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
        additionalProperties?: boolean;
    };
    execute: (callId: string, params: Record<string, unknown>) => Promise<AgentToolResult>;
}

export interface PluginApi {
    pluginConfig: PluginConfig;
    logger?: {
        info: (msg: string, ...args: unknown[]) => void;
        warn: (msg: string, ...args: unknown[]) => void;
        error: (msg: string, ...args: unknown[]) => void;
    };
    registerTool: (tool: PluginTool, opts?: { optional?: boolean }) => void;
}

export interface PluginConfig {
    anthropicApiKey: string;
    browserProfileDir?: string;
    scratchDir?: string;
    outputDir?: string;
    userName?: string;
    location?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function expandTilde(p: string): string {
    if (p === '~') return os.homedir();
    if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
    return p;
}

function textResult(text: string, isError = false): AgentToolResult {
    const result: AgentToolResult = { content: [{ type: 'text', text }] };
    if (isError) result.isError = true;
    return result;
}

function jsonTextResult(payload: unknown, isError = false): AgentToolResult {
    return textResult(JSON.stringify(payload, null, 2), isError);
}

function resolvePaths(config: PluginConfig): {
    browserProfileDir: string;
    scratchDir: string;
    outputDir: string;
} {
    const browserProfileDir = expandTilde(
        config.browserProfileDir ?? path.join(os.homedir(), '.kowalski', 'browser')
    );
    const scratchDir = expandTilde(
        config.scratchDir ?? path.join(os.homedir(), '.kowalski', 'scratch')
    );
    const outputDir = expandTilde(
        config.outputDir ?? path.join(os.homedir(), '.kowalski', 'output')
    );
    return { browserProfileDir, scratchDir, outputDir };
}

// ---------------------------------------------------------------------------
// register — wired into the OpenClaw loader
// ---------------------------------------------------------------------------

export function register(api: PluginApi): () => void {
    const config = api.pluginConfig;
    if (!config || typeof config.anthropicApiKey !== 'string' || config.anthropicApiKey.trim() === '') {
        throw new Error(
            'Kowalski plugin: pluginConfig.anthropicApiKey is required and must be a non-empty string'
        );
    }

    const { browserProfileDir, scratchDir, outputDir } = resolvePaths(config);
    for (const dir of [browserProfileDir, scratchDir, outputDir]) {
        fs.mkdirSync(dir, { recursive: true });
    }

    const sessions = createRegistry();
    const log = api.logger ?? {
        info: (...a: unknown[]) => console.log('[kowalski]', ...a),
        warn: (...a: unknown[]) => console.warn('[kowalski]', ...a),
        error: (...a: unknown[]) => console.error('[kowalski]', ...a),
    };

    // -----------------------------------------------------------------------
    // Stage 6 — agentic login wiring.
    //
    // Credentials come from the process env at register() time. If either
    // var is missing, the `login` tool silently falls through to the Stage 5
    // headful --app window. We deliberately do not throw here — the
    // headful path is a valid operating mode and some users will prefer it.
    // Credentials are NEVER logged, NEVER serialised into tool responses,
    // and NEVER passed into any LLM payload (the LoginAgent's executor
    // reads them during action dispatch, not via the prompt).
    // -----------------------------------------------------------------------
    const igUsername = process.env.IG_USERNAME;
    const igPassword = process.env.IG_PASSWORD;
    const agenticLoginEnabled = Boolean(igUsername && igPassword);
    if (!agenticLoginEnabled) {
        log.info(
            '[kowalski] IG_USERNAME / IG_PASSWORD not set; agentic login disabled, falling back to headful'
        );
    }

    /**
     * Pending-login registry. When LoginAgent pauses on 2FA or device
     * approval, we keep the Playwright page + context alive here so
     * submit_verification_code can resume against the same browser
     * session. Entries older than 15 minutes are GC'd on every login /
     * submit_verification_code call.
     */
    interface PendingLogin {
        loginId: string;
        sessionId: string;
        context: BrowserContext;
        page: Page;
        status: Exclude<LoginPendingStatus, 'success' | 'escalate_to_human'>;
        description: string;
        agent: LoginAgent;
        collector: ScreenshotCollector;
        ghost: GhostMouse;
        scroll: HumanScroll;
        runDir: string;
        createdAt: number;
    }
    const pendingLogins = new Map<string, PendingLogin>();
    const PENDING_TTL_MS = 15 * 60 * 1000;

    async function gcPendingLogins(): Promise<void> {
        const now = Date.now();
        for (const [id, entry] of pendingLogins) {
            if (now - entry.createdAt > PENDING_TTL_MS) {
                try { await entry.context.close(); } catch { /* ignore */ }
                pendingLogins.delete(id);
                log.warn(`[kowalski] pendingLogin ${id} expired after 15min, closed browser`);
            }
        }
    }

    // -----------------------------------------------------------------------
    // Tool: start_session
    //
    // Creates a KowalskiSession bound to the plugin's paths + API key,
    // binds it to the BrowserManager / RunManager singletons, and probes
    // the Instagram sessionid cookie so the agent knows whether to call
    // `login` first.
    //
    // Input:  { phases?: Array<"stories" | "feed"> }
    // Output: JSON text block { session_id, logged_in, message, phases }
    // -----------------------------------------------------------------------
    const startSession: PluginTool = {
        name: 'start_session',
        description:
            'Create a new Kowalski session and probe whether the persistent browser profile is still logged into Instagram. Always call this first. Returns a session_id used by all other tools, and a logged_in flag — if logged_in is false, call the login tool next before run_digest.',
        parameters: {
            type: 'object',
            properties: {
                phases: {
                    type: 'array',
                    items: { type: 'string', enum: ['stories', 'feed'] },
                    description:
                        'Which phases the eventual run_digest call should execute. Defaults to ["stories", "feed"].',
                },
            },
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            const phasesRaw = params.phases;
            const phases = Array.isArray(phasesRaw)
                ? (phasesRaw.filter(
                      (p) => p === 'stories' || p === 'feed'
                  ) as Array<'stories' | 'feed'>)
                : (['stories', 'feed'] as Array<'stories' | 'feed'>);

            const { session, controller } = createKowalskiSession({
                anthropicApiKey: config.anthropicApiKey,
                browserProfileDir,
                scratchDir,
                outputDir,
                runConfig: {
                    userName: config.userName,
                    location: config.location,
                    phases,
                    // Env-sourced Instagram credentials for the agentic
                    // LoginAgent. Never pass these through any structured
                    // response or log payload (see redaction note above).
                    igUsername,
                    igPassword,
                },
            });

            BrowserManager.getInstance().bindSession(session);
            RunManager.getInstance().bindSession(session);
            UsageService.getInstance().configure(session.scratchDir);

            const sessionId = uuidv4();
            const entry: SessionEntry = {
                sessionId,
                session,
                controller,
                events: [],
                lastPhase: null,
                createdAt: Date.now(),
            };
            attachEventBuffer(entry);
            sessions.set(sessionId, entry);

            const probe = probeInstagramLogin(browserProfileDir);
            const message =
                probe.logged_in === true
                    ? 'Session ready. Instagram sessionid cookie is valid — call run_digest when you want to capture.'
                    : probe.logged_in === false
                      ? 'Session ready, but the profile is not logged into Instagram. Call the login tool next (it opens a headful browser window for the user to log in).'
                      : 'Session ready, but the login probe could not be completed. Recommend calling login first before run_digest.';

            log.info('start_session', { sessionId, logged_in: probe.logged_in });
            return jsonTextResult({
                session_id: sessionId,
                logged_in: probe.logged_in,
                phases,
                message,
            });
        },
    };

    // -----------------------------------------------------------------------
    // Tool: login  (Stage 6 — agentic first, headful fallback)
    //
    // Happy path: IG_USERNAME + IG_PASSWORD are set in the plugin env, so
    // we drive a headless Playwright page through the IG login flow with
    // the LoginAgent. Credentials are typed into the page per-character
    // (80–220ms jitter) and NEVER enter the LLM's context — the prompt
    // only ever sees the action names `fill_username` / `fill_password`.
    //
    // Three non-happy branches:
    //   - `pending_2fa` — IG showed a 2FA screen. We register a
    //     PendingLogin and return a JSON blob telling the OpenClaw agent
    //     to ask the user for their code and call submit_verification_code.
    //   - `pending_device_approval` — IG pushed a "notification to another
    //     device" challenge. Same round-trip shape, no code required.
    //   - `escalate_to_human` — the agent got stuck, saw a checkpoint, or
    //     the env vars weren't set. Fall back to the Stage 5 headful
    //     --app window — the existing cookie-polling auto-close still
    //     applies.
    //
    // Input:  { session_id: string } — required so we can route the agent
    //         event stream and resume on the same session on 2FA.
    // Output: text block on success, JSON blob on pending states, or the
    //         existing headful-login text if the env fallback fired.
    // -----------------------------------------------------------------------
    const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
    const AGENTIC_LOGIN_MAX_DURATION_MS = 3 * 60 * 1000;

    async function runHeadfulFallback(): Promise<AgentToolResult> {
        let timer: NodeJS.Timeout | null = null;
        try {
            await Promise.race([
                runLogin(browserProfileDir),
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () =>
                            reject(
                                new Error(
                                    `login: user did not close the browser within ${LOGIN_TIMEOUT_MS / 60000} minutes`
                                )
                            ),
                        LOGIN_TIMEOUT_MS
                    );
                }),
            ]);
            return textResult(`Logged in. Cookies saved to ${browserProfileDir}.`);
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return textResult(`login failed: ${msg}`, true);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    const loginTool: PluginTool = {
        name: 'login',
        description:
            'Log into Instagram. If IG_USERNAME / IG_PASSWORD env vars are set on the host, runs a headless agentic login loop — and can return pending_2fa or pending_device_approval payloads which you must resolve via submit_verification_code. If env vars are unset or the agent escalates, opens a headful Chromium window for the user to finish manually (Stage 5 fallback). Only call when start_session reports logged_in: false.',
        parameters: {
            type: 'object',
            properties: {
                session_id: {
                    type: 'string',
                    description: 'The id returned by start_session. Required so pending_2fa / pending_device_approval payloads can be routed back.',
                },
            },
            required: ['session_id'],
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            await gcPendingLogins();

            const sessionId = params.session_id;
            if (typeof sessionId !== 'string' || !sessionId) {
                return textResult('login: session_id is required.', true);
            }
            const entry = sessions.get(sessionId);
            if (!entry) {
                return textResult(
                    `login: session_id ${sessionId} not found. Call start_session first.`,
                    true
                );
            }

            if (!agenticLoginEnabled) {
                return runHeadfulFallback();
            }

            // Re-bind the singleton — another session may have been the
            // last to bind. Same pattern run_digest uses.
            BrowserManager.getInstance().bindSession(entry.session);
            let context: BrowserContext | null = null;
            let page: Page | null = null;
            let collector: ScreenshotCollector | null = null;
            let agent: LoginAgent | null = null;
            try {
                context = await BrowserManager.getInstance().launch();
                page = context.pages()[0] ?? (await context.newPage());
                await page.goto('https://www.instagram.com/accounts/login/', {
                    waitUntil: 'domcontentloaded',
                    timeout: 30_000,
                });

                const runDir = makeLoginRunDir(entry.session.scratchDir);
                collector = new ScreenshotCollector(page, { saveToDirectory: runDir });
                const ghost = new GhostMouse(page);
                const scroll = new HumanScroll(page);
                agent = new LoginAgent(page, ghost, scroll, collector, {
                    apiKey: entry.session.anthropicApiKey,
                    maxDurationMs: AGENTIC_LOGIN_MAX_DURATION_MS,
                    rawDir: path.join(runDir, 'raw'),
                    credentials: {
                        username: entry.session.runConfig.igUsername ?? '',
                        password: entry.session.runConfig.igPassword ?? '',
                    },
                    browserProfileDir,
                });

                await agent.run();
                const status = agent.finaliseStatus();

                if (status === 'success') {
                    try { collector.flushSessionLog(); } catch { /* ignore */ }
                    try { await context.close(); } catch { /* ignore */ }
                    return textResult(`Logged in agentically. Cookies persisted to ${browserProfileDir}.`);
                }

                if (status === 'pending_2fa' || status === 'pending_device_approval') {
                    const loginId = uuidv4();
                    pendingLogins.set(loginId, {
                        loginId,
                        sessionId,
                        context,
                        page,
                        status,
                        description: agent.pendingDescription ?? '',
                        agent,
                        collector,
                        ghost,
                        scroll,
                        runDir,
                        createdAt: Date.now(),
                    });
                    // Detach from the finally-block cleanup — we're keeping
                    // the browser alive for submit_verification_code.
                    context = null;
                    collector = null;

                    if (status === 'pending_2fa') {
                        return jsonTextResult({
                            status: 'pending_2fa',
                            login_id: loginId,
                            message: 'Ask the user for their Instagram 2FA code, then call submit_verification_code with that login_id and the code.',
                        });
                    }
                    return jsonTextResult({
                        status: 'pending_device_approval',
                        login_id: loginId,
                        device_description: agent.pendingDescription ?? 'another device',
                        message: 'Ask the user to approve the login on the device Instagram named, then call submit_verification_code with login_id and code: null — the tool will poll the page for the approval.',
                    });
                }

                // status === 'escalate_to_human' — close the headless
                // context and fall back to the Stage 5 headful window.
                log.info('[kowalski] LoginAgent escalated, falling back to headful', {
                    reason: agent.pendingDescription,
                });
                try { collector.flushSessionLog(); } catch { /* ignore */ }
                try { await context.close(); } catch { /* ignore */ }
                context = null;
                collector = null;
                return runHeadfulFallback();
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn('[kowalski] agentic login failed, falling back to headful', { msg });
                try { if (collector) collector.flushSessionLog(); } catch { /* ignore */ }
                try { if (context) await context.close(); } catch { /* ignore */ }
                return runHeadfulFallback();
            }
        },
    };

    // -----------------------------------------------------------------------
    // Tool: submit_verification_code
    //
    // Second leg of the 2FA / device-approval round trip. The agent calls
    // this once the user has given them the 2FA code (or has approved the
    // login on their other device).
    //
    // Input:
    //   { login_id: string, code?: string | null }
    //
    // Behavior:
    //   - pending_2fa   → `code` is required; the LoginAgent is resumed
    //                     with the code threaded into its prompt and it
    //                     types the code into the focused input.
    //   - pending_device_approval → `code` is ignored; we poll
    //                     probeInstagramLogin for up to 120s waiting for
    //                     the post-approval transition.
    //
    // On completion or fatal error the entry is removed from pendingLogins
    // and the browser context is closed.
    // -----------------------------------------------------------------------
    const submitVerificationCode: PluginTool = {
        name: 'submit_verification_code',
        description:
            'Second leg of the login 2FA / device-approval round trip. Call after `login` returned pending_2fa (pass the user\'s code) or pending_device_approval (pass code: null — the tool polls for the user approving on their other device). Returns success, failure, or still-pending.',
        parameters: {
            type: 'object',
            properties: {
                login_id: {
                    type: 'string',
                    description: 'The login_id returned by the pending login tool call.',
                },
                code: {
                    type: ['string', 'null'],
                    description: 'The 2FA code for pending_2fa. Null or omitted for pending_device_approval.',
                },
            },
            required: ['login_id'],
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            await gcPendingLogins();

            const loginId = params.login_id;
            if (typeof loginId !== 'string' || !loginId) {
                return textResult('submit_verification_code: login_id is required.', true);
            }
            const entry = pendingLogins.get(loginId);
            if (!entry) {
                return textResult(
                    `submit_verification_code: login_id ${loginId} not found (expired or already resolved).`,
                    true
                );
            }

            const rawCode = params.code;
            const code = typeof rawCode === 'string' && rawCode.trim() ? rawCode.trim() : null;

            const cleanup = async () => {
                pendingLogins.delete(loginId);
                try { entry.collector.flushSessionLog(); } catch { /* ignore */ }
                try { await entry.context.close(); } catch { /* ignore */ }
            };

            try {
                if (entry.status === 'pending_2fa') {
                    if (!code) {
                        return textResult(
                            'submit_verification_code: pending_2fa requires a non-empty code parameter.',
                            true
                        );
                    }
                    // Resume by re-running the LoginAgent against the same
                    // page, with the code threaded into its user prompt.
                    const resumed = new LoginAgent(
                        entry.page,
                        entry.ghost,
                        entry.scroll,
                        entry.collector,
                        {
                            apiKey: sessions.get(entry.sessionId)?.session.anthropicApiKey ?? config.anthropicApiKey,
                            maxDurationMs: AGENTIC_LOGIN_MAX_DURATION_MS,
                            rawDir: path.join(entry.runDir, 'raw'),
                            credentials: {
                                username: sessions.get(entry.sessionId)?.session.runConfig.igUsername ?? '',
                                password: sessions.get(entry.sessionId)?.session.runConfig.igPassword ?? '',
                            },
                            browserProfileDir,
                            verificationCode: code,
                        }
                    );
                    await resumed.run();
                    const status = resumed.finaliseStatus();
                    if (status === 'success') {
                        await cleanup();
                        return textResult(`Logged in agentically (2FA accepted). Cookies persisted to ${browserProfileDir}.`);
                    }
                    if (status === 'pending_2fa') {
                        // Code rejected — update the entry and tell the agent.
                        entry.description = resumed.pendingDescription ?? 'Instagram rejected the 2FA code';
                        entry.createdAt = Date.now();
                        return jsonTextResult({
                            status: 'pending_2fa',
                            login_id: loginId,
                            message: 'The previous code did not work. Ask the user for a fresh code and call submit_verification_code again.',
                        });
                    }
                    // escalate or unexpected pending state — give up on the
                    // headless path and fall back to headful.
                    await cleanup();
                    log.info('[kowalski] submit_verification_code escalated, falling back to headful');
                    return runHeadfulFallback();
                }

                // pending_device_approval — poll for 120s.
                const deadline = Date.now() + 120_000;
                while (Date.now() < deadline) {
                    if (probeInstagramLogin(browserProfileDir).logged_in === true) {
                        await cleanup();
                        return textResult(`Logged in agentically (device approval). Cookies persisted to ${browserProfileDir}.`);
                    }
                    await new Promise((r) => setTimeout(r, 3000));
                }
                // Still pending — keep the entry alive so the user can try again.
                entry.createdAt = Date.now();
                return jsonTextResult({
                    status: 'pending_device_approval',
                    login_id: loginId,
                    message: 'Still waiting for device approval after 120 seconds. Ask the user if they saw the notification; call submit_verification_code again with code: null to poll for another 120s, or accept the headful fallback.',
                });
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn('[kowalski] submit_verification_code failed', { msg });
                await cleanup();
                return textResult(`submit_verification_code failed: ${msg}. The agentic login browser has been closed; re-run the login tool to retry.`, true);
            }
        },
    };

    // -----------------------------------------------------------------------
    // Tool: run_digest
    //
    // Single blocking call that runs stories + feed capture, extraction,
    // and digest generation. Can take tens of minutes. See Stage 3 notes
    // for why this is one blocking tool rather than three async ones.
    //
    // Input:  { session_id: string }
    // Output: text block containing the digest markdown-ish payload
    // -----------------------------------------------------------------------
    const runDigest: PluginTool = {
        name: 'run_digest',
        description:
            'Run the full Kowalski pipeline for a session: capture stories + feed, extract posts, and generate a digest. Blocking call — can take tens of minutes. Returns the digest content. Prefer calling start_session and verifying logged_in: true before this.',
        parameters: {
            type: 'object',
            properties: {
                session_id: {
                    type: 'string',
                    description: 'The id returned by start_session.',
                },
            },
            required: ['session_id'],
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            const sessionId = params.session_id;
            if (typeof sessionId !== 'string' || !sessionId) {
                return textResult('run_digest: session_id is required.', true);
            }
            const entry = sessions.get(sessionId);
            if (!entry) {
                return textResult(
                    `run_digest: session_id ${sessionId} not found. Call start_session first.`,
                    true
                );
            }

            // Re-bind the singletons to this session — another session may have
            // been the last to bind. Cheap and safe.
            BrowserManager.getInstance().bindSession(entry.session);
            RunManager.getInstance().bindSession(entry.session);
            UsageService.getInstance().configure(entry.session.scratchDir);

            try {
                const result = await RunManager.getInstance().startRun({
                    phases: entry.session.runConfig.phases,
                });
                if (!result) {
                    return textResult(
                        'run_digest: RunManager returned null (another run already in progress, or the run aborted before producing a digest). Check get_session_status for details.',
                        true
                    );
                }
                const recordPath = path.join(
                    entry.session.outputDir,
                    'analysis_records',
                    `${result.record.id}.json`
                );
                // Build a one-line phase-timeout summary when anything was cut
                // short. SKILL.md failure-mode list depends on this wording
                // being scannable ("Stories phase timed out after 15 minutes").
                let timeoutSummary = '';
                const timedOut = result.timedOutPhases ?? [];
                if (timedOut.length > 0) {
                    const storyCaps = result.record.data?.images?.filter((i: any) => i.source === 'story').length ?? 0;
                    const feedCaps = result.record.data?.images?.filter((i: any) => i.source === 'feed').length ?? 0;
                    const parts: string[] = [];
                    if (timedOut.includes('stories')) parts.push('Stories phase timed out after 15 minutes');
                    if (timedOut.includes('feed')) parts.push('Feed phase timed out after 30 minutes');
                    if (timedOut.includes('stories') && !timedOut.includes('feed')) {
                        parts.push('feed phase ran to completion');
                    } else if (timedOut.includes('feed') && !timedOut.includes('stories')) {
                        parts.push('stories phase ran to completion');
                    }
                    timeoutSummary =
                        `- ⚠️ ${parts.join('; ')}. ` +
                        `Digest saved with ${storyCaps} story captures + ${feedCaps} feed captures.\n`;
                }
                const header =
                    `# Kowalski digest\n\n` +
                    `- record id: ${result.record.id}\n` +
                    `- saved to: ${recordPath}\n` +
                    `- captures: extracted=${result.counts.extracted}, skipped=${result.counts.skipped}, failed=${result.counts.failed}\n` +
                    timeoutSummary +
                    `- lead story: ${result.record.leadStoryPreview || '(none)'}\n\n`;
                const body = '```json\n' + JSON.stringify(result.record.data, null, 2) + '\n```\n';
                return textResult(header + body);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return textResult(`run_digest failed: ${msg}`, true);
            }
        },
    };

    // -----------------------------------------------------------------------
    // Tool: get_session_status
    //
    // Returns the session's last-emitted run phase plus the most recent
    // ~20 events (run-started / run-phase / analysis-ready / …). Useful
    // both to the agent (polling a long-running run_digest) and to a
    // human debugging a stuck run.
    //
    // Input:  { session_id: string }
    // Output: JSON text block { session_id, last_phase, events }
    // -----------------------------------------------------------------------
    const getSessionStatus: PluginTool = {
        name: 'get_session_status',
        description:
            'Return the latest run phase and last ~20 pipeline events for a session. Useful to check progress on a long-running run_digest call.',
        parameters: {
            type: 'object',
            properties: {
                session_id: {
                    type: 'string',
                    description: 'The id returned by start_session.',
                },
            },
            required: ['session_id'],
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            const sessionId = params.session_id;
            if (typeof sessionId !== 'string' || !sessionId) {
                return textResult('get_session_status: session_id is required.', true);
            }
            const entry = sessions.get(sessionId);
            if (!entry) {
                return textResult(
                    `get_session_status: session_id ${sessionId} not found.`,
                    true
                );
            }
            return jsonTextResult({
                session_id: entry.sessionId,
                created_at: new Date(entry.createdAt).toISOString(),
                last_phase: entry.lastPhase,
                events: entry.events,
            });
        },
    };

    // -----------------------------------------------------------------------
    // Tool: reset_memory
    //
    // Deletes the session-memory JSON under the configured scratchDir.
    // All sessions share the same scratchDir (set by pluginConfig), so
    // this is a single global reset. Safe no-op if the file is absent.
    //
    // Input:  (none)
    // Output: text block confirming what was deleted
    // -----------------------------------------------------------------------
    const resetMemory: PluginTool = {
        name: 'reset_memory',
        description:
            'Delete the cross-run session memory JSON so the next run starts from a clean slate. Call when the user says things like "forget what you learned last week". Idempotent.',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
        execute: async () => {
            const memoryPath = path.join(scratchDir, 'session_memory', 'summaries.json');
            try {
                if (fs.existsSync(memoryPath)) {
                    fs.rmSync(memoryPath, { force: true });
                    return textResult(`Session memory deleted: ${memoryPath}`);
                }
                return textResult(`Session memory already empty: ${memoryPath}`);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return textResult(`reset_memory failed: ${msg}`, true);
            }
        },
    };

    // -----------------------------------------------------------------------
    // Tool: stop_run
    //
    // Request a graceful stop of an in-flight run_digest by writing an empty
    // marker file at `${scratchDir}/STOP_REQUESTED`. RunManager polls for
    // this marker every ~3s and, when it appears, cooperatively stops the
    // active agent and falls through to finalize. The resulting record is
    // tagged with abortReason: 'user-stop'.
    //
    // The tool itself is a cheap filesystem write, so it can be invoked
    // while run_digest is still blocking — some OpenClaw versions dispatch
    // the second call concurrently. If the loader strictly serializes tool
    // calls per-plugin, `touch ~/.kowalski/scratch/STOP_REQUESTED` from a
    // separate terminal achieves the same effect.
    //
    // Input:  { session_id: string }
    // Output: text block "Stop requested..."
    // -----------------------------------------------------------------------
    const stopRun: PluginTool = {
        name: 'stop_run',
        description:
            'Request a graceful stop of an in-flight run_digest. Writes a stop marker that RunManager picks up at the next phase checkpoint (~30s). The run finalizes and produces a partial digest tagged aborted: true, abortReason: user-stop. Use this when the user says "stop the run" / "cancel the digest" / "I\'ve seen enough".',
        parameters: {
            type: 'object',
            properties: {
                session_id: {
                    type: 'string',
                    description: 'The id returned by start_session.',
                },
            },
            required: ['session_id'],
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            const sessionId = params.session_id;
            if (typeof sessionId !== 'string' || !sessionId) {
                return textResult('stop_run: session_id is required.', true);
            }
            const entry = sessions.get(sessionId);
            if (!entry) {
                return textResult(`stop_run: session_id ${sessionId} not found.`, true);
            }
            const markerPath = path.join(entry.session.scratchDir, 'STOP_REQUESTED');
            try {
                fs.writeFileSync(markerPath, '');
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return textResult(`stop_run: failed to write stop marker at ${markerPath}: ${msg}`, true);
            }
            return textResult(
                'Stop requested. The run will finalize at the next phase checkpoint (within ~30 seconds) and produce a partial digest.'
            );
        },
    };

    // -----------------------------------------------------------------------
    // Tool: end_session
    //
    // Aborts the session's controller, closes any open Playwright context
    // via BrowserManager, and drops the session from the registry.
    //
    // Input:  { session_id: string }
    // Output: text block "Session ended."
    // -----------------------------------------------------------------------
    const endSession: PluginTool = {
        name: 'end_session',
        description:
            'Abort any in-flight run for a session, close the Playwright context, and forget the session_id. Call when the user is done or wants to free resources.',
        parameters: {
            type: 'object',
            properties: {
                session_id: {
                    type: 'string',
                    description: 'The id returned by start_session.',
                },
            },
            required: ['session_id'],
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            const sessionId = params.session_id;
            if (typeof sessionId !== 'string' || !sessionId) {
                return textResult('end_session: session_id is required.', true);
            }
            const entry = sessions.get(sessionId);
            if (!entry) {
                return textResult(`end_session: session_id ${sessionId} not found.`, true);
            }

            try {
                entry.controller.abort();
            } catch {
                // ignore — abort on an already-aborted controller is a no-op
            }

            try {
                const ctx = entry.session.browser?.context;
                if (ctx) await ctx.close();
            } catch (err) {
                log.warn('end_session: browser context close failed', err);
            }

            sessions.delete(sessionId);
            return textResult('Session ended.');
        },
    };

    api.registerTool(startSession);
    api.registerTool(loginTool);
    api.registerTool(submitVerificationCode);
    api.registerTool(runDigest);
    api.registerTool(getSessionStatus);
    api.registerTool(resetMemory);
    api.registerTool(stopRun);
    api.registerTool(endSession);

    log.info('Kowalski plugin registered', {
        browserProfileDir,
        scratchDir,
        outputDir,
        tools: 8,
        agenticLogin: agenticLoginEnabled,
    });

    return () => {
        for (const entry of sessions.values()) {
            try {
                entry.controller.abort();
            } catch {
                /* ignore */
            }
        }
        sessions.clear();
        // Close any pending-login browsers left over at teardown.
        for (const [, pending] of pendingLogins) {
            pending.context.close().catch(() => { /* ignore */ });
        }
        pendingLogins.clear();
    };
}

// Default export — the plain shape the OpenClaw loader accepts
// (loader.ts accepts `def.register ?? def.activate`). Matches the
// MemOS-Cloud reference plugin pattern. We intentionally do not import
// `definePluginEntry` from `@openclaw/plugin-sdk` — that package is
// workspace-private in the openclaw monorepo and is not published to
// npm. See REFACTOR_NOTES.md › Stage 3 for the full finding.
export default {
    id: 'kowalski-openclaw',
    name: 'Kowalski',
    description: 'Browses your Instagram stories and feed and returns a markdown digest.',
    kind: 'capability' as const,
    register,
};
