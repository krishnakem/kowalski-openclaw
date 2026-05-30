/**
 * OpenClaw plugin entrypoint for Kowalski.
 *
 * Exposes eleven tools that drive the Kowalski pipeline. `start_session`
 * is the preferred entrypoint: it probes cookies, starts login if needed,
 * and starts the digest automatically once Instagram auth is verified.
 * See REFACTOR_NOTES.md for the stage-by-stage refactor history and why
 * this uses the plain default-export plugin shape instead of
 * `definePluginEntry`.
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
import { probeInstagramLogin } from './cookie-probe.js';
import { writeDigestPdf } from './digest-pdf.js';
import { keyStore } from './keyStore.js';
import {
    attachEventBuffer,
    createRegistry,
    type SessionEntry,
} from './session-registry.js';

let cachedAnthropicApiKey: string | null = null;

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
    anthropicApiKey?: string;
    browserProfileDir?: string;
    scratchDir?: string;
    outputDir?: string;
    userName?: string;
    location?: string;
    /**
     * Where to write the text-only digest PDF emitted at the end of every
     * `run_digest` call. Defaults to `$HOME/Downloads`. Tildes are NOT
     * expanded here — set an absolute path if you want anything else.
     */
    downloadsDir?: string;
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

function cleanApiKey(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

function pendingApiKeyResult(): AgentToolResult {
    return jsonTextResult({
        status: 'pending_api_key',
        message:
            'No Anthropic API key is configured. Ask the user for their Anthropic API key (starts with sk-ant-) and call set_api_key, then retry. (On a headless server with no OS keychain, set the ANTHROPIC_API_KEY env var instead.)',
    });
}

async function validateAnthropicApiKey(apiKey: string): Promise<{ ok: true } | { ok: false; message: string }> {
    try {
        const response = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'x-api-key': apiKey,
                'anthropic-version': '2023-06-01',
            },
            body: JSON.stringify({
                model: 'claude-haiku-4-5',
                max_tokens: 1,
                messages: [{ role: 'user', content: 'ping' }],
            }),
            signal: AbortSignal.timeout(30_000),
        });

        if (response.ok) return { ok: true };
        if (response.status === 401 || response.status === 403) {
            return {
                ok: false,
                message: 'Anthropic rejected the API key. Please check that it starts with sk-ant- and is active.',
            };
        }
        return {
            ok: false,
            message: `Anthropic API key validation failed with HTTP ${response.status}. Please try again later.`,
        };
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
            ok: false,
            message: `Anthropic API key validation could not complete: ${msg}`,
        };
    }
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
    const config = api.pluginConfig ?? {};

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

    function resolveAnthropicApiKey(): string | null {
        const fromConfig = cleanApiKey(config.anthropicApiKey);
        if (fromConfig) {
            cachedAnthropicApiKey = fromConfig;
            return fromConfig;
        }

        const fromEnv = cleanApiKey(process.env.ANTHROPIC_API_KEY);
        if (fromEnv) {
            cachedAnthropicApiKey = fromEnv;
            return fromEnv;
        }

        if (cachedAnthropicApiKey) {
            return cachedAnthropicApiKey;
        }

        const fromKeychain = keyStore.get();
        if (fromKeychain) {
            cachedAnthropicApiKey = fromKeychain;
            return fromKeychain;
        }

        return null;
    }

    // -----------------------------------------------------------------------
    // Stage 6 — agentic login wiring.
    //
    // Credential resolution order for the LoginAgent, highest-priority first:
    //   1. `username` / `password` params on the `login` tool call itself.
    //      The canonical path: the agent prompts the user in the TUI and
    //      forwards whatever they type back into the tool.
    //   2. `IG_USERNAME` / `IG_PASSWORD` process env vars set at gateway
    //      launch. Power-user convenience for unattended scheduled runs.
    //   3. Neither — the `login` tool returns `pending_credentials` and the
    //      agent is expected to ask the user in the TUI, then call `login`
    //      again with the params. There is no manual browser-window fallback;
    //      every login attempt stays headless.
    //
    // Credentials are cached in-memory per session (on KowalskiSession.runConfig)
    // so the agentic flow can resume across pending_2fa round trips without
    // asking the user a second time. They are NEVER logged, NEVER serialised
    // into tool responses, and NEVER passed into any LLM payload (the
    // LoginAgent's executor reads them during action dispatch, not via the
    // prompt).
    // -----------------------------------------------------------------------
    const envIgUsername = process.env.IG_USERNAME;
    const envIgPassword = process.env.IG_PASSWORD;
    if (envIgUsername && envIgPassword) {
        log.info('[kowalski] IG_USERNAME / IG_PASSWORD found in env; agentic login will use them unless login is called with username/password params.');
    } else {
        log.info(
            '[kowalski] IG_USERNAME / IG_PASSWORD not set in env; login tool will request credentials from the agent via pending_credentials on first call.'
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

    async function startDigestForEntry(
        sessionId: string,
        entry: SessionEntry,
        triggeredBy: string,
        extraPayload: Record<string, unknown> = {}
    ): Promise<AgentToolResult> {
        // Guard against concurrent runs. If there's already an active
        // digest that isn't finished, reject — the user should either
        // wait, poll get_session_status, or call stop_run first.
        if (entry.activeDigest && entry.activeDigest.status === 'running') {
            return jsonTextResult({
                status: 'already_running',
                session_id: sessionId,
                triggered_by: triggeredBy,
                started_at: new Date(entry.activeDigest.startedAt).toISOString(),
                message:
                    'A digest is already running on this session. Poll get_session_status for progress, or call stop_run to abort.',
                ...extraPayload,
            });
        }

        // Re-bind the singletons to this session — another session may have
        // been the last to bind. Cheap and safe.
        BrowserManager.getInstance().bindSession(entry.session);
        RunManager.getInstance().bindSession(entry.session);
        UsageService.getInstance().configure(entry.session.scratchDir);

        const STORIES_CAP_MS = entry.session.runConfig.storiesTimeoutMs ?? 15 * 60_000;
        const FEED_CAP_MS = entry.session.runConfig.feedTimeoutMs ?? 30 * 60_000;
        const runStartedAt = Date.now();
        let currentPhase: 'stories' | 'feed' | 'idle' = 'idle';
        let phaseStartedAt = runStartedAt;

        const fmt = (ms: number): string => {
            if (ms < 0) ms = 0;
            const s = Math.floor(ms / 1000);
            const m = Math.floor(s / 60);
            const secs = s - m * 60;
            return `${m}m${secs.toString().padStart(2, '0')}s`;
        };

        log.info(
            `run_digest started by ${triggeredBy} (non-blocking) — phases=${JSON.stringify(entry.session.runConfig.phases)} storiesCap=${fmt(STORIES_CAP_MS)} feedCap=${fmt(FEED_CAP_MS)} · ticks every 5 min + on phase transitions. Say "stop" any time to abort.`
        );

        const onPhase = (payload: { phase?: 'stories' | 'feed' }): void => {
            if (payload?.phase === 'stories' || payload?.phase === 'feed') {
                const previous = currentPhase;
                currentPhase = payload.phase;
                phaseStartedAt = Date.now();
                const cap = currentPhase === 'stories' ? STORIES_CAP_MS : FEED_CAP_MS;
                if (previous === 'idle') {
                    log.info(`⏱ phase=${currentPhase} STARTED — cap=${fmt(cap)}`);
                } else {
                    log.info(
                        `⏱ phase ${previous} DONE → ${currentPhase} STARTED — ${currentPhase} cap=${fmt(cap)}  totalElapsed=${fmt(Date.now() - runStartedAt)}`
                    );
                }
            }
        };
        entry.session.events.on('run-phase', onPhase);

        const TICK_INTERVAL_MS = 5 * 60_000;
        const tick = setInterval(() => {
            const now = Date.now();
            const totalElapsed = now - runStartedAt;
            if (currentPhase === 'idle') {
                log.info(
                    `⏱ phase=idle  totalElapsed=${fmt(totalElapsed)} (waiting for first phase to start…)`
                );
                return;
            }
            const cap = currentPhase === 'stories' ? STORIES_CAP_MS : FEED_CAP_MS;
            const phaseElapsed = now - phaseStartedAt;
            const remaining = cap - phaseElapsed;
            log.info(
                `⏱ phase=${currentPhase}  elapsed=${fmt(phaseElapsed)}/${fmt(cap)}  remaining=${fmt(remaining)}  totalElapsed=${fmt(totalElapsed)}`
            );
        }, TICK_INTERVAL_MS);

        // Initialise ActiveDigest so get_session_status + stop_run can
        // see a run is in flight.
        entry.activeDigest = {
            startedAt: runStartedAt,
            status: 'running',
            tickerHandle: tick,
            detachPhaseListener: () => {
                try { entry.session.events.off('run-phase', onPhase); } catch { /* ignore */ }
            },
        };

        // Fire-and-forget: run the pipeline in the background. The
        // promise writes its outcome back into entry.activeDigest and
        // tears down the ticker/listeners when done.
        (async () => {
            try {
                const result = await RunManager.getInstance().startRun({
                    phases: entry.session.runConfig.phases,
                });
                if (!result) {
                    entry.activeDigest!.status = 'failed';
                    entry.activeDigest!.errorMessage =
                        'RunManager returned null (another run already in progress, or the run aborted before producing a digest).';
                    log.warn(`❌ run_digest: RunManager returned null (no result)`);
                    return;
                }

                const recordPath = path.join(
                    entry.session.outputDir,
                    'analysis_records',
                    `${result.record.id}.json`
                );

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

                let pdfLine = '';
                try {
                    const aborted = Boolean(
                        (result.record.data as any)?.metadata?.aborted
                    );
                    const abortReason =
                        (result.record.data as any)?.metadata?.abortReason;
                    const pdfPath = await writeDigestPdf(result.record, {
                        downloadsDir: config.downloadsDir,
                        aborted,
                        abortReason,
                    });
                    pdfLine = `- pdf: ${pdfPath}\n`;
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    log.warn('[kowalski] PDF export failed (non-fatal)', { msg });
                    pdfLine = `- pdf: (failed to write — ${msg})\n`;
                }

                const aborted = Boolean((result.record.data as any)?.metadata?.aborted);
                const abortReason = (result.record.data as any)?.metadata?.abortReason;
                const header =
                    `# Kowalski digest\n\n` +
                    `- record id: ${result.record.id}\n` +
                    `- saved to: ${recordPath}\n` +
                    pdfLine +
                    `- captures: extracted=${result.counts.extracted}, skipped=${result.counts.skipped}, failed=${result.counts.failed}\n` +
                    timeoutSummary +
                    `- lead story: ${result.record.leadStoryPreview || '(none)'}\n\n`;
                const body = '```json\n' + JSON.stringify(result.record.data, null, 2) + '\n```\n';

                entry.activeDigest!.resultText = header + body;
                entry.activeDigest!.status =
                    aborted && abortReason === 'user-stop' ? 'stopped' : 'completed';
                log.info(
                    `✅ run_digest complete — totalElapsed=${fmt(Date.now() - runStartedAt)} record=${result.record.id} status=${entry.activeDigest!.status}`
                );
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                entry.activeDigest!.status = 'failed';
                entry.activeDigest!.errorMessage = msg;
                log.warn(
                    `❌ run_digest failed — totalElapsed=${fmt(Date.now() - runStartedAt)} error=${msg}`
                );
            } finally {
                if (entry.activeDigest?.tickerHandle) {
                    clearInterval(entry.activeDigest.tickerHandle);
                    entry.activeDigest.tickerHandle = null;
                }
                try {
                    entry.activeDigest?.detachPhaseListener?.();
                } catch { /* ignore */ }
                if (entry.activeDigest) {
                    entry.activeDigest.detachPhaseListener = null;
                }
            }
        })();

        return jsonTextResult({
            status: 'started',
            session_id: sessionId,
            triggered_by: triggeredBy,
            started_at: new Date(runStartedAt).toISOString(),
            stories_cap_ms: STORIES_CAP_MS,
            feed_cap_ms: FEED_CAP_MS,
            message:
                'Digest started in the background. The run is in flight (10-30 min typical, ~45 min worst case) and the user can say "stop" any time. Progress ticks stream to the TUI log pane every 5 min. To fetch the final digest, call get_session_status; when digest_status is "completed" or "stopped" the response includes the full result and auto-ends the session.',
            ...extraPayload,
        });
    }

    // -----------------------------------------------------------------------
    // Tool: start_session
    //
    // Creates a KowalskiSession bound to the plugin's paths + API key,
    // binds it to the BrowserManager / RunManager singletons, probes the
    // Instagram sessionid cookie, and immediately advances the workflow:
    // valid cookie -> start digest; missing/unknown cookie -> run login.
    //
    // Input:  { phases?: Array<"stories" | "feed"> }
    // Output: JSON text block for digest-started or login-pending state.
    // -----------------------------------------------------------------------
    const startSession: PluginTool = {
        name: 'start_session',
        description:
            'Create a Kowalski session and automatically continue the workflow. If the persistent browser profile has a valid Instagram cookie, this starts run_digest immediately. If not, this automatically starts the headless login flow; when credentials/2FA/device approval are needed it returns the relevant pending_* payload. Once login succeeds, the digest is started automatically.',
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
            const anthropicApiKey = resolveAnthropicApiKey();
            if (!anthropicApiKey) {
                return pendingApiKeyResult();
            }

            const phasesRaw = params.phases;
            const phases = Array.isArray(phasesRaw)
                ? (phasesRaw.filter(
                      (p) => p === 'stories' || p === 'feed'
                  ) as Array<'stories' | 'feed'>)
                : (['stories', 'feed'] as Array<'stories' | 'feed'>);

            const { session, controller } = createKowalskiSession({
                anthropicApiKey,
                browserProfileDir,
                scratchDir,
                outputDir,
                runConfig: {
                    userName: config.userName,
                    location: config.location,
                    phases,
                    // Seed with env-sourced Instagram credentials if the
                    // host set them. The login tool will override these on
                    // a per-call basis if the agent passes username/password
                    // params (which is the canonical TUI-prompt path).
                    // Never pass these through any structured response or
                    // log payload (see redaction note above).
                    igUsername: envIgUsername,
                    igPassword: envIgPassword,
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
            log.info('start_session', { sessionId, logged_in: probe.logged_in });

            if (probe.logged_in === true) {
                return startDigestForEntry(sessionId, entry, 'start_session', {
                    logged_in: true,
                    phases,
                });
            }

            return loginTool.execute('start_session:auto-login', {
                ...params,
                session_id: sessionId,
                triggered_by: 'start_session',
                login_probe: probe.logged_in,
            });
        },
    };

    // -----------------------------------------------------------------------
    // Tool: login  (Stage 6 — headless agentic login only)
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
    //   - `escalate_to_human` — the agent got stuck or saw a checkpoint
    //     that cannot be cleared in a headless flow. Return a structured
    //     login_failed_needs_manual result so the host can tell the user
    //     how to clear the challenge outside the plugin and retry.
    //
    // Input:  { session_id: string } — required so we can route the agent
    //         event stream and resume on the same session on 2FA.
    // Output: text block on success, JSON blob on pending states or
    //         headless-only failure states.
    // -----------------------------------------------------------------------
    const AGENTIC_LOGIN_MAX_DURATION_MS = 3 * 60 * 1000;
    const LOGIN_FAILED_NEEDS_MANUAL_MESSAGE =
        "Instagram showed a challenge the automated login can't clear headlessly (e.g. a suspicious-login check). Try again later, or approve/clear the challenge from the Instagram app on your phone, then retry login.";

    function loginFailedNeedsManualResult(reason?: string | null): AgentToolResult {
        const cleanReason =
            typeof reason === 'string' && reason.trim()
                ? reason.trim()
                : 'Instagram showed a login challenge the automated flow cannot clear headlessly.';
        return jsonTextResult(
            {
                status: 'login_failed_needs_manual',
                reason: cleanReason,
                message: LOGIN_FAILED_NEEDS_MANUAL_MESSAGE,
            },
            true
        );
    }

    const loginTool: PluginTool = {
        name: 'login',
        description:
            'Continue the automatic Kowalski workflow through Instagram login. This tool resolves credentials, drives the headless LoginAgent, returns pending_credentials / pending_2fa / pending_device_approval when user input is needed, and automatically starts run_digest as soon as login is verified.',
        parameters: {
            type: 'object',
            properties: {
                session_id: {
                    type: 'string',
                    description: 'The id returned by start_session. Required so pending_2fa / pending_device_approval payloads can be routed back.',
                },
                username: {
                    type: 'string',
                    description: 'Instagram username or email. Ask the user in the TUI on first login — do NOT hardcode or guess. Cached on the session for the rest of the login round trip so you only need to ask once. Optional; if omitted, falls back to IG_USERNAME env var, and if that is also unset the tool returns pending_credentials.',
                },
                password: {
                    type: 'string',
                    description: 'Instagram password. Ask the user in the TUI on first login — do NOT hardcode or guess. Cached on the session for the rest of the login round trip. Optional; if omitted, falls back to IG_PASSWORD env var, and if that is also unset the tool returns pending_credentials.',
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
            const triggeredBy =
                typeof params.triggered_by === 'string' ? params.triggered_by : 'login';

            const alreadyLoggedIn = probeInstagramLogin(browserProfileDir);
            if (alreadyLoggedIn.logged_in === true) {
                return startDigestForEntry(sessionId, entry, triggeredBy, {
                    logged_in: true,
                    login_status: 'already_logged_in',
                });
            }

            // ----- Resolve credentials: params > session cache > env -----
            const paramUsername =
                typeof params.username === 'string' && params.username.trim()
                    ? params.username.trim()
                    : undefined;
            const paramPassword =
                typeof params.password === 'string' && params.password
                    ? params.password
                    : undefined;

            if (paramUsername) entry.session.runConfig.igUsername = paramUsername;
            if (paramPassword) entry.session.runConfig.igPassword = paramPassword;

            const effectiveUsername =
                entry.session.runConfig.igUsername ?? envIgUsername;
            const effectivePassword =
                entry.session.runConfig.igPassword ?? envIgPassword;

            if (!effectiveUsername || !effectivePassword) {
                return jsonTextResult({
                    status: 'pending_credentials',
                    session_id: sessionId,
                    triggered_by: triggeredBy,
                    logged_in: alreadyLoggedIn.logged_in,
                    message:
                        'No Instagram credentials available. Ask the user in the TUI for their Instagram username (or email/phone) and password, then call `login` again with this session_id plus `username` and `password` params. When login succeeds, run_digest will start automatically. Never guess or reuse old creds. If the user declines to share credentials in chat, login cannot continue because this plugin is headless-only.',
                });
            }
            // Persist resolved creds on the session so submit_verification_code
            // can pick them up too.
            entry.session.runConfig.igUsername = effectiveUsername;
            entry.session.runConfig.igPassword = effectivePassword;

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
                    return startDigestForEntry(sessionId, entry, triggeredBy, {
                        logged_in: true,
                        login_status: 'success',
                    });
                }

                if (status === 'pending_2fa' || status === 'pending_device_approval') {
                    const loginId = uuidv4();
                    // CRITICAL: detach the context from BrowserManager's
                    // singleton slot. Without this, any subsequent call to
                    // BrowserManager.launch() (e.g. a stray re-login from
                    // the agent, or a premature run_digest) would close
                    // this context mid-2FA via the zombie-prevention path
                    // in launch(). pendingLogins now owns its lifetime;
                    // cleanup() in submit_verification_code closes it.
                    try {
                        BrowserManager.getInstance().detachContext();
                    } catch (detachErr) {
                        log.warn('[kowalski] detachContext failed (continuing)', {
                            err: detachErr instanceof Error ? detachErr.message : String(detachErr),
                        });
                    }
                    // If the stored context gets closed out-of-band (e.g.
                    // Chromium crash, user killed the process), drop the
                    // pending entry so the agent gets a clean
                    // "login_id not found" instead of a confusing stale
                    // handle on the next submit_verification_code.
                    try {
                        context.on('close', () => {
                            if (pendingLogins.has(loginId)) {
                                log.warn('[kowalski] pending login context closed unexpectedly; dropping entry', { loginId });
                                pendingLogins.delete(loginId);
                            }
                        });
                    } catch { /* ignore — context.on should always work */ }

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
                            session_id: sessionId,
                            login_id: loginId,
                            triggered_by: triggeredBy,
                            message: 'Ask the user for their Instagram 2FA code, then call submit_verification_code with that login_id and the code. When verification succeeds, run_digest will start automatically.',
                        });
                    }
                    return jsonTextResult({
                        status: 'pending_device_approval',
                        session_id: sessionId,
                        login_id: loginId,
                        device_description: agent.pendingDescription ?? 'another device',
                        triggered_by: triggeredBy,
                        message: 'Ask the user to approve the login on the device Instagram named, then call submit_verification_code with login_id and code: null — the tool will poll the page for the approval. When approval succeeds, run_digest will start automatically.',
                    });
                }

                // status === 'escalate_to_human' — close the headless
                // context and return a structured failure for the host.
                log.info('[kowalski] LoginAgent escalated; returning headless-only manual-needed result', {
                    reason: agent.pendingDescription,
                });
                try { collector.flushSessionLog(); } catch { /* ignore */ }
                try { await context.close(); } catch { /* ignore */ }
                context = null;
                collector = null;
                return loginFailedNeedsManualResult(agent.pendingDescription);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                log.warn('[kowalski] agentic login failed; returning headless-only manual-needed result', { msg });
                try { if (collector) collector.flushSessionLog(); } catch { /* ignore */ }
                try { if (context) await context.close(); } catch { /* ignore */ }
                return loginFailedNeedsManualResult(`Headless login failed before completion: ${msg}`);
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

            // Defensive: the stored context may have been closed out-of-band
            // (Chromium crash, BrowserManager.launch() before we wired in
            // detachContext, etc.). Surface a clean, actionable error
            // instead of letting a "Target closed" exception bubble up
            // from inside LoginAgent.run().
            const contextClosed = (() => {
                try {
                    if (entry.page.isClosed()) return true;
                    // BrowserContext has no .isClosed(); probing a page is
                    // the most reliable liveness check without issuing a
                    // network op.
                    return false;
                } catch {
                    return true;
                }
            })();
            if (contextClosed) {
                pendingLogins.delete(loginId);
                return jsonTextResult({
                    status: 'context_destroyed',
                    login_id: loginId,
                    message:
                        'The login browser was closed before the code was submitted (likely a stale pending entry or an out-of-band close). Re-run the `login` tool to start fresh — Instagram may not ask for 2FA again if cookies got partially persisted.',
                });
            }

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
                    const sessionEntry = sessions.get(entry.sessionId);
                    if (!sessionEntry) {
                        await cleanup();
                        return textResult(
                            `submit_verification_code: session ${entry.sessionId} not found. Start a new session to retry.`,
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
                            apiKey: sessionEntry.session.anthropicApiKey,
                            maxDurationMs: AGENTIC_LOGIN_MAX_DURATION_MS,
                            rawDir: path.join(entry.runDir, 'raw'),
                            credentials: {
                                username: sessionEntry.session.runConfig.igUsername ?? '',
                                password: sessionEntry.session.runConfig.igPassword ?? '',
                            },
                            browserProfileDir,
                            verificationCode: code,
                        }
                    );
                    await resumed.run();
                    const status = resumed.finaliseStatus();
                    if (status === 'success') {
                        await cleanup();
                        return startDigestForEntry(entry.sessionId, sessionEntry, 'submit_verification_code', {
                            logged_in: true,
                            login_status: 'success_2fa',
                        });
                    }
                    if (status === 'pending_2fa') {
                        // Code rejected — update the entry and tell the agent.
                        entry.description = resumed.pendingDescription ?? 'Instagram rejected the 2FA code';
                        entry.createdAt = Date.now();
                        return jsonTextResult({
                            status: 'pending_2fa',
                            session_id: entry.sessionId,
                            login_id: loginId,
                            message: 'The previous code did not work. Ask the user for a fresh code and call submit_verification_code again. When verification succeeds, run_digest will start automatically.',
                        });
                    }
                    // Escalation or an unexpected pending state means the
                    // headless flow cannot continue.
                    await cleanup();
                    log.info('[kowalski] submit_verification_code escalated; returning headless-only manual-needed result', {
                        reason: resumed.pendingDescription,
                    });
                    return loginFailedNeedsManualResult(
                        resumed.pendingDescription ??
                            'Instagram did not accept the verification round-trip and needs manual challenge clearance.'
                    );
                }

                // pending_device_approval — poll for 120s.
                const deadline = Date.now() + 120_000;
                while (Date.now() < deadline) {
                    if (probeInstagramLogin(browserProfileDir).logged_in === true) {
                        await cleanup();
                        const sessionEntry = sessions.get(entry.sessionId);
                        if (!sessionEntry) {
                            return textResult(
                                `Logged in agentically (device approval), but session ${entry.sessionId} is gone. Start a new session to run the digest.`,
                                true
                            );
                        }
                        return startDigestForEntry(entry.sessionId, sessionEntry, 'submit_verification_code', {
                            logged_in: true,
                            login_status: 'success_device_approval',
                        });
                    }
                    await new Promise((r) => setTimeout(r, 3000));
                }
                // Still pending — keep the entry alive so the user can try again.
                entry.createdAt = Date.now();
                return jsonTextResult({
                    status: 'pending_device_approval',
                    session_id: entry.sessionId,
                    login_id: loginId,
                    message: 'Still waiting for device approval after 120 seconds. Ask the user if they saw the notification, then call submit_verification_code again with code: null to poll for another 120s. When approval succeeds, run_digest will start automatically.',
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
    // Kicks off the Kowalski pipeline in the background and returns
    // IMMEDIATELY with `{status: "started"}`. The actual digest is
    // fetched later via `get_session_status` (which returns the full
    // result once `digest_status === "completed"`).
    //
    // Why non-blocking? OpenClaw serializes tool dispatch per plugin.
    // A blocking run_digest means no other tool (including `stop_run`)
    // can fire until the run ends on its own — turning "stop" in the
    // TUI into a no-op until the 30-45 minute run is done. Returning
    // immediately frees the dispatcher so `stop_run` takes effect
    // within ~30s whenever the user wants to abort.
    //
    // Input:  { session_id: string }
    // Output: text block { status: "started" | "already_running", … }
    // -----------------------------------------------------------------------
    const runDigest: PluginTool = {
        name: 'run_digest',
        description:
            'Manually kick off the Kowalski pipeline (stories + feed capture, extraction, digest generation) in the background. Normally start_session/login/submit_verification_code starts this automatically once Instagram auth is verified. Returns IMMEDIATELY with `{status: "started"}` — does NOT block. The actual run takes 10–30 min (worst case ~45 min) and costs ~$1–3 in Anthropic spend; warn the user before starting any digest workflow. HARD TIMEOUTS: stories 15 min, feed 30 min; on timeout the digest finalizes with `aborted: true, abortReason: "timeout-stories"|"timeout-feed"`. After a started response, tell the user the run is in flight and call `get_session_status` when they ask whether it is done.',
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
            return startDigestForEntry(sessionId, entry, 'run_digest');
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
            'Return the latest run phase and last ~20 pipeline events for a session. Useful to check progress on a long-running run_digest call. NOTE: the call that first surfaces a terminal status (`digest_result` for completed/stopped, `digest_error` for failed) ALSO auto-ends the session — the response will include `session_ended: true` and subsequent polls will return `session_id not found`. Hand the digest back to the user immediately on that response.',
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

            const ad = entry.activeDigest;
            const digestStatus = ad ? ad.status : 'idle';
            const payload: Record<string, unknown> = {
                session_id: entry.sessionId,
                created_at: new Date(entry.createdAt).toISOString(),
                last_phase: entry.lastPhase,
                digest_status: digestStatus,
                events: entry.events,
            };
            // Auto-end the session once the agent has seen a terminal
            // state. Gated on first-delivery so we don't tear down before
            // the digest payload is handed back: completed/stopped end on
            // the call that delivers `digest_result`; failed ends on the
            // call that surfaces `digest_error`.
            let shouldEnd = false;
            if (ad) {
                payload.digest_started_at = new Date(ad.startedAt).toISOString();
                if (ad.status === 'running') {
                    payload.digest_elapsed_ms = Date.now() - ad.startedAt;
                }
                if (ad.status === 'failed' && ad.errorMessage) {
                    payload.digest_error = ad.errorMessage;
                    if (!ad.resultDelivered) {
                        ad.resultDelivered = true;
                        shouldEnd = true;
                    }
                }
                // Deliver the result exactly once: after the agent has
                // seen it, clear resultText so subsequent status polls
                // don't re-emit a giant payload. The agent is expected
                // to return it to the user the first time.
                if ((ad.status === 'completed' || ad.status === 'stopped') && ad.resultText) {
                    payload.digest_result = ad.resultText;
                    if (!ad.resultDelivered) {
                        ad.resultDelivered = true;
                        shouldEnd = true;
                    }
                }
            }

            if (shouldEnd) {
                try { entry.controller.abort(); } catch { /* ignore */ }
                try {
                    const ctx = entry.session.browser?.context;
                    if (ctx) await ctx.close();
                } catch (err) {
                    log.warn('get_session_status: auto-end browser close failed', err);
                }
                sessions.delete(sessionId);
                payload.session_ended = true;
            }

            return jsonTextResult(payload);
        },
    };

    // -----------------------------------------------------------------------
    // Tool: set_api_key
    //
    // Validates an Anthropic API key with a minimal 1-token request, stores
    // it in the OS keychain, and updates the module-scope cache for the
    // current gateway process. The key is never logged or echoed.
    // -----------------------------------------------------------------------
    const setApiKey: PluginTool = {
        name: 'set_api_key',
        description:
            'Validate and store the Anthropic API key in the OS keychain. Call when start_session returns pending_api_key. Never log or echo the key. On headless servers without an OS keychain, this may fail and the user should set ANTHROPIC_API_KEY instead.',
        parameters: {
            type: 'object',
            properties: {
                api_key: {
                    type: 'string',
                    description: 'Anthropic API key from the user. It usually starts with sk-ant-. Never echo this value back.',
                },
            },
            required: ['api_key'],
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            const apiKey = cleanApiKey(params.api_key);
            if (!apiKey) {
                return textResult('set_api_key: api_key is required.', true);
            }

            const validation = await validateAnthropicApiKey(apiKey);
            if (!validation.ok) {
                return textResult(validation.message, true);
            }

            try {
                keyStore.set(apiKey);
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return textResult(`set_api_key failed: ${msg}`, true);
            }

            cachedAnthropicApiKey = apiKey;
            return textResult('Anthropic API key validated and stored in the OS keychain. You can retry start_session now.');
        },
    };

    // -----------------------------------------------------------------------
    // Tool: clear_api_key
    //
    // Clears the stored OS-keychain key and drops the in-memory cache. This
    // does not mutate OpenClaw plugin config or process env vars.
    // -----------------------------------------------------------------------
    const clearApiKey: PluginTool = {
        name: 'clear_api_key',
        description:
            'Clear the Anthropic API key stored in the OS keychain and forget the in-memory cached key. Idempotent. Does not clear OpenClaw plugin config or ANTHROPIC_API_KEY env vars.',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
        execute: async () => {
            keyStore.clear();
            cachedAnthropicApiKey = null;
            return textResult('Stored Anthropic API key cleared from the OS keychain.');
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
    // Tool: reset_all
    //
    // The nuclear option. Wipes everything Kowalski owns on disk and in
    // memory so the user is back to a factory state:
    //
    //   - Browser profile (cookies, cached session, saved logins)
    //   - Scratch dir     (session memory, STOP_REQUESTED markers, run temp)
    //   - Output dir      (analysis_records/, per-run screenshots)
    //   - Stored Anthropic API key in the OS keychain
    //   - In-memory       (active sessions, pending-login browsers, usage stats)
    //
    // Does NOT touch:
    //   - The plugin's OpenClaw config (anthropicApiKey, downloadsDir,
    //     userName, location, browserProfileDir override). Those are
    //     OpenClaw-managed; the user clears them via `openclaw config unset`.
    //   - The user's Downloads folder. Any digest PDFs already exported
    //     there are safe — we only ever *write* to that folder, never
    //     list or delete its contents.
    //
    // Requires `confirm: true` to guard against accidental triggering.
    // Empty/missing confirm returns a description of what *would* be
    // deleted without touching anything.
    // -----------------------------------------------------------------------
    const resetAll: PluginTool = {
        name: 'reset_all',
        description:
            'Full factory reset: closes all active sessions + pending-login browsers, deletes the browser profile (login cookies included), scratch dir, all analysis records, and the Anthropic API key stored in the OS keychain. Requires `confirm: true` — call without it first to preview what will be wiped. Does NOT delete digest PDFs already written to Downloads, and does NOT clear OpenClaw plugin config or ANTHROPIC_API_KEY env vars.',
        parameters: {
            type: 'object',
            properties: {
                confirm: {
                    type: 'boolean',
                    description:
                        'Must be true to actually wipe data. Omit or set false to get a dry-run preview listing exactly which paths would be deleted.',
                },
            },
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            const targetPaths = [
                { label: 'browser profile', path: browserProfileDir },
                { label: 'scratch dir', path: scratchDir },
                { label: 'output dir (analysis records + run screenshots)', path: outputDir },
            ];

            if (params.confirm !== true) {
                const lines = targetPaths.map(
                    (t) => `  - ${t.label}: ${t.path}`
                );
                return textResult(
                    'reset_all dry-run. To actually wipe, call again with { confirm: true }.\n\n' +
                        'Will delete:\n' +
                        lines.join('\n') +
                        `\n\n` +
                        `Active sessions that will be aborted: ${sessions.size}\n` +
                        `Pending-login browsers that will be closed: ${pendingLogins.size}\n\n` +
                        'Will also clear: Anthropic API key stored in the OS keychain.\n\n' +
                        'Will NOT touch: OpenClaw plugin config, ANTHROPIC_API_KEY env vars, or digest PDFs already in Downloads.'
                );
            }

            const errors: string[] = [];

            // 1. Abort any in-memory sessions. Their run_digest calls are
            //    likely blocking the gateway — aborting the controller
            //    unblocks LLM waits; the RunManager stop-marker handles
            //    in-flight phases. We also write the marker explicitly
            //    so any already-running phases start tearing down.
            try {
                fs.mkdirSync(scratchDir, { recursive: true });
                fs.writeFileSync(
                    path.join(scratchDir, 'STOP_REQUESTED'),
                    String(Date.now())
                );
            } catch {
                /* scratch dir about to be nuked anyway */
            }
            for (const entry of sessions.values()) {
                try {
                    entry.controller.abort();
                } catch {
                    /* ignore */
                }
            }
            sessions.clear();

            // 2. Close pending-login browsers.
            for (const [id, plogin] of pendingLogins) {
                try {
                    await plogin.context.close();
                } catch {
                    /* ignore */
                }
                pendingLogins.delete(id);
            }

            // 2a. Clear the stored key. Idempotent, and intentionally
            // best-effort: data reset should continue even if the keychain
            // backend is unavailable.
            keyStore.clear();
            cachedAnthropicApiKey = null;

            // 3. rm -rf the three managed dirs, then recreate empty ones
            //    so subsequent start_session calls don't ENOENT.
            const deleted: string[] = [];
            for (const t of targetPaths) {
                try {
                    if (fs.existsSync(t.path)) {
                        fs.rmSync(t.path, { recursive: true, force: true });
                    }
                    fs.mkdirSync(t.path, { recursive: true });
                    deleted.push(`${t.label}: ${t.path}`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    errors.push(`${t.label} (${t.path}): ${msg}`);
                }
            }

            // 4. Rebind singletons — BrowserManager holds a closed
            //    persistent context reference that's now on a deleted
            //    path. Dropping session bindings is enough; the next
            //    start_session rebinds cleanly.

            const summary =
                'reset_all complete.\n\n' +
                'Deleted:\n' +
                deleted.map((d) => `  - ${d}`).join('\n') +
                '\n  - Anthropic API key stored in the OS keychain' +
                (errors.length
                    ? '\n\nErrors:\n' + errors.map((e) => `  - ${e}`).join('\n')
                    : '') +
                '\n\nNext step: call start_session. You will need to log in again (cookies are gone), and provide an API key again unless OpenClaw config or ANTHROPIC_API_KEY still supplies one.';

            log.info('reset_all', { deleted: deleted.length, errors: errors.length });
            return textResult(summary, errors.length > 0);
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

            // Belt-and-suspenders: write the STOP_REQUESTED marker AND call
            // RunManager.stopRun() directly in-process.
            //   - Marker: resilient to out-of-band stops (e.g. user types
            //     `touch …/STOP_REQUESTED` in a terminal, or this tool is
            //     invoked across multiple runs). RunManager polls it on
            //     a 3s setInterval.
            //   - Direct call: fires instantly (no 3s poll latency) and,
            //     thanks to the AbortController integration in stopRun,
            //     tears down any in-flight Anthropic fetch immediately.
            // Either mechanism alone would work; together they give the
            // fastest, most reliable stop.
            const markerPath = path.join(entry.session.scratchDir, 'STOP_REQUESTED');
            try {
                fs.writeFileSync(markerPath, '');
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return textResult(`stop_run: failed to write stop marker at ${markerPath}: ${msg}`, true);
            }

            try {
                RunManager.getInstance().stopRun();
            } catch (err) {
                // Non-fatal: the marker poller is the fallback.
                const msg = err instanceof Error ? err.message : String(err);
                log.warn('[kowalski] stop_run: RunManager.stopRun() threw (marker still written)', { msg });
            }

            return textResult(
                'Stop requested. The run will finalize within ~30 seconds (usually faster, since the stop aborts any in-flight LLM call) and produce a partial digest. Call get_session_status — when digest_status is "stopped" the response includes the partial result.'
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
    api.registerTool(setApiKey);
    api.registerTool(clearApiKey);
    api.registerTool(resetMemory);
    api.registerTool(resetAll);
    api.registerTool(stopRun);
    api.registerTool(endSession);

    log.info('Kowalski plugin registered', {
        browserProfileDir,
        scratchDir,
        outputDir,
        tools: 11,
        envCredentialsPresent: Boolean(envIgUsername && envIgPassword),
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
