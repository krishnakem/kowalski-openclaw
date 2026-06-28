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
 * OpenClaw may call `register(api)` more than once in one gateway process
 * (for example around agent/session refreshes). Per-session state therefore
 * lives in a process-global map so a pending 2FA browser survives plugin
 * re-registration until submit_verification_code resumes it.
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
import { createInferenceClient, type OpenClawRuntimeLike } from '../main/services/Inference.js';
import {
    attachEventBuffer,
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
    runtime?: OpenClawRuntimeLike;
    rootDir?: string;
    logger?: {
        info: (msg: string, ...args: unknown[]) => void;
        warn: (msg: string, ...args: unknown[]) => void;
        error: (msg: string, ...args: unknown[]) => void;
    };
    registerTool: (tool: PluginTool, opts?: { optional?: boolean }) => void;
}

export interface PluginConfig {
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
    /**
     * Deprecated compatibility escape hatch. Scheduled follow-up turns require
     * a configured OpenClaw delivery channel in newer gateway versions, so the
     * default workflow avoids asking the host agent to create cron jobs.
     */
    enableScheduledPolling?: boolean;
}

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

interface KowalskiPluginGlobalState {
    sessions: Map<string, SessionEntry>;
    pendingLogins: Map<string, PendingLogin>;
    registrations: number;
}

const GLOBAL_STATE_KEY = '__kowalskiOpenClawPluginState';

function getPluginGlobalState(): KowalskiPluginGlobalState {
    const root = globalThis as typeof globalThis & {
        [GLOBAL_STATE_KEY]?: KowalskiPluginGlobalState;
    };
    if (!root[GLOBAL_STATE_KEY]) {
        root[GLOBAL_STATE_KEY] = {
            sessions: new Map<string, SessionEntry>(),
            pendingLogins: new Map<string, PendingLogin>(),
            registrations: 0,
        };
    }
    return root[GLOBAL_STATE_KEY];
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

function readStringField(obj: unknown, key: string): string | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    const value = (obj as Record<string, unknown>)[key];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readEnvSecret(name: string): string | undefined {
    const value = process.env[name];
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function readInstagramSessionIdEnv(): { value?: string; source?: string } {
    for (const name of ['IG_SESSIONID', 'INSTAGRAM_SESSIONID']) {
        const raw = readEnvSecret(name);
        if (!raw) continue;

        const cookiePair = raw
            .split(';')
            .map((part) => part.trim())
            .find((part) => part.startsWith('sessionid='));
        const value = cookiePair ? cookiePair.slice('sessionid='.length).trim() : raw;
        if (value) return { value, source: name };
    }
    return {};
}

function readPositiveNumberField(obj: unknown, key: string): number | undefined {
    if (!obj || typeof obj !== 'object') return undefined;
    const value = (obj as Record<string, unknown>)[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value;
    if (typeof value === 'string' && value.trim()) {
        const parsed = Number(value.trim());
        if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
    return undefined;
}

function formatMinutes(ms: number): string {
    const minutes = ms / 60_000;
    return Number.isInteger(minutes) ? `${minutes}` : minutes.toFixed(1);
}

function deriveRunDurations(
    totalMinutes: number,
    phases: Array<'stories' | 'feed'>
): {
    maxDurationMs: number;
    storiesTimeoutMs?: number;
    feedTimeoutMs?: number;
} {
    const maxDurationMs = Math.ceil(totalMinutes * 60_000);
    const hasStories = phases.includes('stories');
    const hasFeed = phases.includes('feed');

    if (hasStories && hasFeed) {
        return {
            maxDurationMs,
            storiesTimeoutMs: Math.max(1, Math.round(maxDurationMs * 0.3)),
            feedTimeoutMs: Math.max(1, maxDurationMs - Math.round(maxDurationMs * 0.3)),
        };
    }

    return {
        maxDurationMs,
        storiesTimeoutMs: hasStories ? maxDurationMs : undefined,
        feedTimeoutMs: hasFeed ? maxDurationMs : undefined,
    };
}

function markdownFromRecordData(data: unknown): string {
    const markdown = readStringField(data, 'markdown');
    if (markdown) return markdown;

    const title = readStringField(data, 'title') ?? 'Kowalski Digest';
    const lines = [`# ${title}`];
    if (data && typeof data === 'object') {
        const sections = (data as Record<string, unknown>).sections;
        if (Array.isArray(sections)) {
            for (const section of sections) {
                if (!section || typeof section !== 'object') continue;
                const heading = readStringField(section, 'heading');
                const content = (section as Record<string, unknown>).content;
                if (heading) lines.push('', `## ${heading}`);
                if (Array.isArray(content)) {
                    for (const paragraph of content) {
                        if (typeof paragraph === 'string' && paragraph.trim()) {
                            lines.push('', paragraph.trim());
                        }
                    }
                }
            }
        }
    }
    return lines.join('\n').trim();
}

function buildPrintableDigest(args: {
    record: { id: string; data: unknown; leadStoryPreview?: string };
    recordPath?: string;
    pdfPath?: string;
    counts?: { extracted: number; skipped: number; failed: number };
    timeoutSummary?: string;
}): string {
    const markdown = markdownFromRecordData(args.record.data);
    const artifactLines = [
        '',
        '---',
        '',
        'Kowalski artifacts:',
        `- record id: ${args.record.id}`,
    ];
    if (args.recordPath) artifactLines.push(`- JSON record: ${args.recordPath}`);
    if (args.pdfPath) artifactLines.push(`- PDF: ${args.pdfPath}`);
    if (args.counts) {
        artifactLines.push(
            `- captures: extracted=${args.counts.extracted}, skipped=${args.counts.skipped}, failed=${args.counts.failed}`
        );
    }

    if (args.timeoutSummary) artifactLines.push(args.timeoutSummary.trim());

    return `${markdown.trim()}\n${artifactLines.join('\n')}\n`;
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

    const globalState = getPluginGlobalState();
    globalState.registrations += 1;
    const sessions = globalState.sessions;
    const pendingLogins = globalState.pendingLogins;
    const log = api.logger ?? {
        info: (...a: unknown[]) => console.log('[kowalski]', ...a),
        warn: (...a: unknown[]) => console.warn('[kowalski]', ...a),
        error: (...a: unknown[]) => console.error('[kowalski]', ...a),
    };

    function shouldEnableScheduledPolling(): boolean {
        return config.enableScheduledPolling === true;
    }

    function pendingDigestMessage(prefix = 'Digest is still running.'): string {
        if (shouldEnableScheduledPolling()) {
            return `${prefix} Stay silent and schedule another print_digest check in 30 seconds.`;
        }
        return `${prefix} Do not create a scheduled/cron follow-up unless the user has configured an OpenClaw delivery channel; wait for an explicit status/print request instead.`;
    }

    // -----------------------------------------------------------------------
    // Stage 6 — agentic login wiring.
    //
    // Credential resolution for the LoginAgent:
    //   - `IG_USERNAME` / `IG_PASSWORD` process env vars set at gateway launch.
    //   - Neither — the `login` tool returns `pending_credentials` and tells
    //     the host to set env vars outside the LLM/tool-call path. There is no
    //     manual browser-window fallback; every login attempt stays headless.
    //
    // Credentials are cached in-memory per session (on KowalskiSession.runConfig)
    // so the agentic flow can resume across pending_2fa round trips without
    // asking the user a second time. They are NEVER logged, NEVER serialised
    // into tool responses, accepted as tool params, or passed into any LLM
    // payload (the LoginAgent's executor reads them during action dispatch,
    // not via the prompt).
    // -----------------------------------------------------------------------
    const envIgUsername = readEnvSecret('IG_USERNAME');
    const envIgPassword = readEnvSecret('IG_PASSWORD');
    const envIgSessionId = readInstagramSessionIdEnv();
    if (envIgUsername && envIgPassword) {
        log.info('[kowalski] IG_USERNAME / IG_PASSWORD found in env; agentic login can use them.');
    } else {
        log.info(
            '[kowalski] IG_USERNAME / IG_PASSWORD not set in env; login tool will return pending_credentials with env setup instructions.'
        );
    }
    if (envIgSessionId.value) {
        log.info(`[kowalski] ${envIgSessionId.source} found in env; browser context will inject the Instagram session cookie.`);
    }

    /**
     * Pending-login registry. When LoginAgent pauses on 2FA or device
     * approval, we keep the Playwright page + context alive here so
     * submit_verification_code can resume against the same browser
     * session. This map is process-global because OpenClaw can re-register
     * plugins between chat turns; entries older than 15 minutes are GC'd on
     * every login / submit_verification_code call.
     */
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

    function resolvePendingLogin(
        loginId: string | null,
        sessionId: string | null
    ): { loginId: string; entry: PendingLogin } | { error: AgentToolResult } {
        if (loginId) {
            const direct = pendingLogins.get(loginId);
            if (direct) return { loginId, entry: direct };

            const candidates = [...pendingLogins.entries()].filter(
                ([, pending]) => !sessionId || pending.sessionId === sessionId
            );
            if (candidates.length === 1) {
                const [fallbackLoginId, fallbackEntry] = candidates[0];
                log.warn('[kowalski] submit_verification_code received stale login_id; using only pending login fallback', {
                    requestedLoginId: loginId,
                    fallbackLoginId,
                    sessionId: fallbackEntry.sessionId,
                });
                return { loginId: fallbackLoginId, entry: fallbackEntry };
            }

            return {
                error: textResult(
                    `submit_verification_code: login_id ${loginId} not found (expired, already resolved, or replaced).`,
                    true
                ),
            };
        }

        const candidates = [...pendingLogins.entries()].filter(
            ([, pending]) => !sessionId || pending.sessionId === sessionId
        );
        if (candidates.length === 0) {
            return {
                error: textResult(
                    sessionId
                        ? `submit_verification_code: no active pending login found for session ${sessionId}.`
                        : 'submit_verification_code: no active pending login found.',
                    true
                ),
            };
        }
        if (candidates.length > 1) {
            return {
                error: textResult(
                    'submit_verification_code: multiple pending logins are active. Pass the login_id returned by login, or pass session_id to disambiguate.',
                    true
                ),
            };
        }

        const [fallbackLoginId, fallbackEntry] = candidates[0];
        log.info('[kowalski] submit_verification_code using sole pending login fallback', {
            loginId: fallbackLoginId,
            sessionId: fallbackEntry.sessionId,
        });
        return { loginId: fallbackLoginId, entry: fallbackEntry };
    }

    function findLatestDigestSession(excludeSessionId?: string | null): SessionEntry | null {
        let best: SessionEntry | null = null;
        const rank = (entry: SessionEntry): number => {
            const status = entry.activeDigest?.status;
            if (status === 'running') return 3;
            if (status === 'completed' || status === 'stopped') return 2;
            if (status === 'failed') return 1;
            return 0;
        };

        for (const candidate of sessions.values()) {
            if (excludeSessionId && candidate.sessionId === excludeSessionId) continue;
            if (!candidate.activeDigest) continue;
            if (!best) {
                best = candidate;
                continue;
            }
            const candidateRank = rank(candidate);
            const bestRank = rank(best);
            if (
                candidateRank > bestRank ||
                (candidateRank === bestRank &&
                    candidate.activeDigest.startedAt > best.activeDigest!.startedAt)
            ) {
                best = candidate;
            }
        }
        return best;
    }

    function buildSessionStatusPayload(
        entry: SessionEntry,
        redirectedFromSessionId?: string | null
    ): Record<string, unknown> {
        const ad = entry.activeDigest;
        const digestStatus = ad ? ad.status : 'idle';
        const payload: Record<string, unknown> = {
            session_id: entry.sessionId,
            created_at: new Date(entry.createdAt).toISOString(),
            last_phase: entry.lastPhase,
            digest_status: digestStatus,
            events: entry.events,
        };
        if (redirectedFromSessionId) {
            payload.redirected_from_session_id = redirectedFromSessionId;
            payload.message =
                `The requested session (${redirectedFromSessionId}) has no active digest, but session ${entry.sessionId} does. Use this session_id for future status, stop, and print_digest calls.`;
        }
        if (ad) {
            payload.digest_started_at = new Date(ad.startedAt).toISOString();
            const timerTotalMs = entry.session.runConfig.maxDurationMs;
            const timerElapsedMs = Math.max(0, Date.now() - ad.startedAt);
            if (typeof timerTotalMs === 'number' && Number.isFinite(timerTotalMs)) {
                payload.timer_total_ms = timerTotalMs;
                payload.timer_elapsed_ms = timerElapsedMs;
                payload.timer_remaining_ms = Math.max(0, timerTotalMs - timerElapsedMs);
            }
            if (ad.status === 'running') {
                payload.digest_elapsed_ms = timerElapsedMs;
            }
            if (ad.status === 'failed' && ad.errorMessage) {
                payload.digest_error = ad.errorMessage;
            }
            if ((ad.status === 'completed' || ad.status === 'stopped') && ad.resultText) {
                payload.digest_ready = true;
                payload.digest_record_id = ad.recordId;
                payload.digest_record_path = ad.recordPath;
                payload.digest_pdf_path = ad.pdfPath;
                payload.next_tool = {
                    name: 'print_digest',
                    arguments: {
                        session_id: entry.sessionId,
                        record_id: ad.recordId,
                    },
                };
                payload.message =
                    redirectedFromSessionId
                        ? `The requested session (${redirectedFromSessionId}) has no active digest, but session ${entry.sessionId} is ready. Immediately call print_digest with this session_id and record_id, then present the returned markdown to the user verbatim.`
                        : 'Digest is ready. Immediately call print_digest with this session_id and record_id, then present the returned markdown to the user verbatim.';
            }
        }
        return payload;
    }

    async function readSavedDigest(recordId: string): Promise<string | { error: AgentToolResult }> {
        const recordPath = path.join(outputDir, 'analysis_records', `${recordId}.json`);
        try {
            const raw = await fs.promises.readFile(recordPath, 'utf-8');
            const parsed = JSON.parse(raw) as {
                id?: unknown;
                data?: unknown;
                leadStoryPreview?: unknown;
            };
            if (typeof parsed.id !== 'string') {
                return {
                    error: textResult(`print_digest: record ${recordId} is missing a string id.`, true),
                };
            }
            return buildPrintableDigest({
                record: {
                    id: parsed.id,
                    data: parsed.data,
                    leadStoryPreview:
                        typeof parsed.leadStoryPreview === 'string'
                            ? parsed.leadStoryPreview
                            : undefined,
                },
                recordPath,
            });
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            return {
                error: textResult(`print_digest: failed to read record ${recordId}: ${msg}`, true),
            };
        }
    }

    async function findLatestSavedRecordId(): Promise<string | null> {
        const recordDir = path.join(outputDir, 'analysis_records');
        try {
            const entries = await fs.promises.readdir(recordDir, { withFileTypes: true });
            const files = await Promise.all(entries
                .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
                .map(async (entry) => {
                    const fullPath = path.join(recordDir, entry.name);
                    const stat = await fs.promises.stat(fullPath);
                    return {
                        recordId: entry.name.slice(0, -'.json'.length),
                        mtimeMs: stat.mtimeMs,
                    };
                }));
            files.sort((a, b) => b.mtimeMs - a.mtimeMs);
            return files[0]?.recordId ?? null;
        } catch {
            return null;
        }
    }

    async function returnCompletedDigest(
        sessionId: string,
        entry: SessionEntry
    ): Promise<AgentToolResult> {
        const ad = entry.activeDigest;
        if (!ad) {
            return jsonTextResult({
                status: 'pending',
                digest_status: 'idle',
                session_id: sessionId,
                silent: true,
                recommended_next_poll_ms: 30_000,
                message: 'No digest has started on this session yet.',
            });
        }

        if (ad.status === 'running' && ad.completionPromise) {
            await ad.completionPromise;
        }

        if (ad.status === 'failed') {
            return jsonTextResult({
                status: 'failed',
                digest_status: 'failed',
                session_id: sessionId,
                silent: false,
                digest_error: ad.errorMessage ?? 'Digest failed.',
                message: 'Digest failed. Tell the user this error.',
            }, true);
        }

        if (ad.status !== 'completed' && ad.status !== 'stopped') {
            return jsonTextResult({
                status: 'pending',
                digest_status: ad.status,
                session_id: sessionId,
                digest_started_at: new Date(ad.startedAt).toISOString(),
                digest_elapsed_ms: Date.now() - ad.startedAt,
                silent: true,
                recommended_next_poll_ms: 30_000,
                message: 'Digest is still running.',
            });
        }

        if (!ad.resultText) {
            return textResult(
                `run_digest: digest ${sessionId} completed but no printable result was stored.`,
                true
            );
        }

        ad.resultDelivered = true;
        try { entry.controller.abort(); } catch { /* ignore */ }
        try {
            const ctx = entry.session.browser?.context;
            if (ctx) await ctx.close();
        } catch (err) {
            log.warn('run_digest: auto-end browser close failed', err);
        }
        sessions.delete(entry.sessionId);
        return textResult(ad.resultText);
    }

    async function startDigestForEntry(
        sessionId: string,
        entry: SessionEntry,
        triggeredBy: string,
        extraPayload: Record<string, unknown> = {},
        options: { waitForCompletion?: boolean } = {}
    ): Promise<AgentToolResult> {
        // Guard against concurrent runs. If there's already an active
        // digest that isn't finished, reject — the user should either
        // wait, poll get_session_status, or call stop_run first.
        if (entry.activeDigest && entry.activeDigest.status === 'running') {
            if (options.waitForCompletion) {
                return returnCompletedDigest(sessionId, entry);
            }
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

        const getStoriesCapMs = () => entry.session.runConfig.storiesTimeoutMs ?? 15 * 60_000;
        const getFeedCapMs = () => entry.session.runConfig.feedTimeoutMs ?? 30 * 60_000;
        const getTotalCapMs = () => entry.session.runConfig.maxDurationMs ?? getStoriesCapMs() + getFeedCapMs();
        const STORIES_CAP_MS = getStoriesCapMs();
        const FEED_CAP_MS = getFeedCapMs();
        const TOTAL_CAP_MS = getTotalCapMs();
        const activePhases = entry.session.runConfig.phases ?? ['stories', 'feed'];
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
        const phaseCapMessage = activePhases.includes('stories') && activePhases.includes('feed')
            ? `The phase caps are stories=${formatMinutes(STORIES_CAP_MS)} min and feed/posts=${formatMinutes(FEED_CAP_MS)} min.`
            : activePhases.includes('stories')
                ? `The stories cap is ${formatMinutes(STORIES_CAP_MS)} min.`
                : `The feed/posts cap is ${formatMinutes(FEED_CAP_MS)} min.`;

        const mode = options.waitForCompletion ? 'blocking' : 'non-blocking';
        log.info(
            `run_digest started by ${triggeredBy} (${mode}) — phases=${JSON.stringify(activePhases)} totalCap=${fmt(TOTAL_CAP_MS)} storiesCap=${fmt(STORIES_CAP_MS)} feedCap=${fmt(FEED_CAP_MS)} · ticks every 5 min + on phase transitions. Say "stop" any time to abort.`
        );

        const onPhase = (payload: { phase?: 'stories' | 'feed' }): void => {
            if (payload?.phase === 'stories' || payload?.phase === 'feed') {
                const previous = currentPhase;
                currentPhase = payload.phase;
                phaseStartedAt = Date.now();
                const cap = currentPhase === 'stories' ? getStoriesCapMs() : getFeedCapMs();
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
            const cap = currentPhase === 'stories' ? getStoriesCapMs() : getFeedCapMs();
            const phaseElapsed = now - phaseStartedAt;
            const remaining = cap - phaseElapsed;
            log.info(
                `⏱ phase=${currentPhase}  elapsed=${fmt(phaseElapsed)}/${fmt(cap)}  remaining=${fmt(remaining)}  totalElapsed=${fmt(totalElapsed)}/${fmt(getTotalCapMs())}`
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
        const completionPromise = (async () => {
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
                    if (timedOut.includes('stories')) {
                        parts.push(`Stories phase timed out after ${formatMinutes(getStoriesCapMs())} minutes`);
                    }
                    if (timedOut.includes('feed')) {
                        parts.push(`Feed phase timed out after ${formatMinutes(getFeedCapMs())} minutes`);
                    }
                    if (timedOut.includes('stories') && !timedOut.includes('feed')) {
                        parts.push('feed phase ran to completion');
                    } else if (timedOut.includes('feed') && !timedOut.includes('stories')) {
                        parts.push('stories phase ran to completion');
                    }
                    timeoutSummary =
                        `- ⚠️ ${parts.join('; ')}. ` +
                        `Digest saved with ${storyCaps} story captures + ${feedCaps} feed captures.\n`;
                }

                let pdfPath: string | undefined;
                try {
                    const aborted = Boolean(
                        (result.record.data as any)?.metadata?.aborted ??
                        (result.record.data as any)?.aborted
                    );
                    const abortReason =
                        (result.record.data as any)?.metadata?.abortReason ??
                        (result.record.data as any)?.abortReason;
                    pdfPath = await writeDigestPdf(result.record, {
                        downloadsDir: config.downloadsDir,
                        aborted,
                        abortReason,
                    });
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    log.warn('[kowalski] PDF export failed (non-fatal)', { msg });
                }

                const aborted = Boolean(
                    (result.record.data as any)?.metadata?.aborted ??
                    (result.record.data as any)?.aborted
                );
                const abortReason =
                    (result.record.data as any)?.metadata?.abortReason ??
                    (result.record.data as any)?.abortReason;
                entry.activeDigest!.recordId = result.record.id;
                entry.activeDigest!.recordPath = recordPath;
                entry.activeDigest!.pdfPath = pdfPath;
                entry.activeDigest!.resultText = buildPrintableDigest({
                    record: result.record,
                    recordPath,
                    pdfPath,
                    counts: result.counts,
                    timeoutSummary: timeoutSummary || undefined,
                });
                entry.activeDigest!.status =
                    aborted && abortReason === 'user-stop' ? 'stopped' : 'completed';
                const pdfLine = pdfPath ? ` pdf=${pdfPath}` : '';
                log.info(
                    `✅ run_digest complete — totalElapsed=${fmt(Date.now() - runStartedAt)} record=${result.record.id} status=${entry.activeDigest!.status}${pdfLine}`
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
        entry.activeDigest.completionPromise = completionPromise;

        if (options.waitForCompletion) {
            return returnCompletedDigest(sessionId, entry);
        }

        return jsonTextResult({
            status: 'started',
            session_id: sessionId,
            inference_backend: entry.session.inferenceClient.backend,
            triggered_by: triggeredBy,
            started_at: new Date(runStartedAt).toISOString(),
            total_cap_ms: TOTAL_CAP_MS,
            stories_cap_ms: STORIES_CAP_MS,
            feed_cap_ms: FEED_CAP_MS,
            split: activePhases.includes('stories') && activePhases.includes('feed')
                ? { stories_pct: 30, feed_pct: 70 }
                : undefined,
            automatic_scheduled_polling: shouldEnableScheduledPolling(),
            recommended_initial_print_poll_ms: 30_000,
            recommended_repeat_print_poll_ms: 30_000,
            vision_model_warning: entry.session.inferenceClient.backend === 'openclaw'
                ? 'Kowalski requires a vision-capable OpenClaw image model. If screenshots cannot be understood, configure agents.defaults.imageModel to a vision-capable model.'
                : undefined,
            message: shouldEnableScheduledPolling()
                ? `Digest started in the background for up to ${formatMinutes(TOTAL_CAP_MS)} minutes. ${phaseCapMessage} The user can say "stop" any time. A configured-channel client may schedule silent print_digest checks every 30 seconds until the display-ready markdown is returned.`
                : `Digest started in the background for up to ${formatMinutes(TOTAL_CAP_MS)} minutes. ${phaseCapMessage} The user can say "stop" any time. Do not create OpenClaw cron/scheduled follow-up turns by default; when the user asks for status or results, call get_session_status or print_digest with this session_id.`,
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
    // Input:  { duration_minutes: number, phases?: Array<"stories" | "feed"> }
    // Output: JSON text block for digest-started or login-pending state.
    // -----------------------------------------------------------------------
    const startSession: PluginTool = {
        name: 'start_session',
        description:
            'Create a Kowalski session for a user-requested duration and automatically continue the workflow. Ask the user how many minutes they want before calling; pass that as duration_minutes. If both phases run, Kowalski splits time 30/70: stories 30%, feed/posts 70%. If the persistent browser profile has a valid Instagram cookie, this starts run_digest immediately. If not, this automatically starts the headless login flow; when credentials/2FA/device approval are needed it returns the relevant pending_* payload. Once login succeeds, the digest is started automatically.',
        parameters: {
            type: 'object',
            properties: {
                duration_minutes: {
                    type: 'number',
                    minimum: 1,
                    maximum: 180,
                    description:
                        'Total capture budget in minutes requested by the user. With both phases, Kowalski uses a 30/70 split: stories get 30%, feed/posts get 70%.',
                },
                phases: {
                    type: 'array',
                    items: { type: 'string', enum: ['stories', 'feed'] },
                    description:
                        'Which phases the eventual run_digest call should execute. Defaults to ["stories", "feed"].',
                },
            },
            required: ['duration_minutes'],
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            const durationMinutes = readPositiveNumberField(params, 'duration_minutes');
            if (!durationMinutes || durationMinutes > 180) {
                return jsonTextResult({
                    status: 'pending_duration',
                    message:
                        'Ask the user how many minutes they would like the Kowalski run to be, then call start_session with duration_minutes between 1 and 180.',
                });
            }

            const phasesRaw = params.phases;
            const phases = Array.isArray(phasesRaw)
                ? (phasesRaw.filter(
                      (p) => p === 'stories' || p === 'feed'
                  ) as Array<'stories' | 'feed'>)
                : (['stories', 'feed'] as Array<'stories' | 'feed'>);
            const effectivePhases = phases.length > 0 ? phases : (['stories', 'feed'] as Array<'stories' | 'feed'>);
            const durations = deriveRunDurations(durationMinutes, effectivePhases);
            log.info('timer set', {
                durationMinutes,
                phases: effectivePhases,
                totalCapMs: durations.maxDurationMs,
                storiesCapMs: durations.storiesTimeoutMs,
                feedCapMs: durations.feedTimeoutMs,
                split: effectivePhases.includes('stories') && effectivePhases.includes('feed')
                    ? '30/70 stories/feed-posts'
                    : 'single-phase',
            });
            log.info(
                `[kowalski] timer set: total=${formatMinutes(durations.maxDurationMs)}m stories=${formatMinutes(durations.storiesTimeoutMs ?? 0)}m feed/posts=${formatMinutes(durations.feedTimeoutMs ?? 0)}m`
            );

            let inferenceClient;
            try {
                inferenceClient = createInferenceClient({
                    runtime: api.runtime,
                    scratchDir,
                    agentDir: api.rootDir,
                    workspaceDir: process.cwd(),
                });
            } catch (err) {
                return textResult(
                    err instanceof Error ? err.message : String(err),
                    true
                );
            }

            const { session, controller } = createKowalskiSession({
                inferenceClient,
                browserProfileDir,
                scratchDir,
                outputDir,
                runConfig: {
                    userName: config.userName,
                    location: config.location,
                    phases: effectivePhases,
                    maxDurationMs: durations.maxDurationMs,
                    storiesTimeoutMs: durations.storiesTimeoutMs,
                    feedTimeoutMs: durations.feedTimeoutMs,
                    // Seed sensitive Instagram values only from env. These
                    // stay in process memory for the active session and are
                    // never accepted through tool params or emitted in
                    // responses/logs.
                    igUsername: envIgUsername,
                    igPassword: envIgPassword,
                    igSessionId: envIgSessionId.value,
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
                    phases: effectivePhases,
                });
            }

            if (envIgSessionId.value) {
                return startDigestForEntry(sessionId, entry, 'start_session', {
                    logged_in: 'env_sessionid',
                    phases: effectivePhases,
                });
            }

            return loginTool.execute('start_session:auto-login', {
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
            'Continue the automatic Kowalski workflow through Instagram login. Credentials must be supplied via IG_USERNAME / IG_PASSWORD environment variables; this tool does not accept secrets as parameters. It drives the headless LoginAgent, returns pending_credentials / pending_2fa / pending_device_approval when user input is needed, and automatically starts run_digest as soon as login is verified.',
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
            const triggeredBy =
                typeof params.triggered_by === 'string' ? params.triggered_by : 'login';

            const alreadyLoggedIn = probeInstagramLogin(browserProfileDir);
            if (alreadyLoggedIn.logged_in === true) {
                return startDigestForEntry(sessionId, entry, triggeredBy, {
                    logged_in: true,
                    login_status: 'already_logged_in',
                });
            }

            // ----- Resolve credentials from env-seeded session state only -----
            const effectiveUsername = entry.session.runConfig.igUsername;
            const effectivePassword = entry.session.runConfig.igPassword;

            if (!effectiveUsername || !effectivePassword) {
                return jsonTextResult({
                    status: 'pending_credentials',
                    session_id: sessionId,
                    triggered_by: triggeredBy,
                    logged_in: alreadyLoggedIn.logged_in,
                    message:
                        'No Instagram credentials are available in the gateway environment. Set IG_USERNAME and IG_PASSWORD outside the LLM/tool-call path, restart the OpenClaw gateway so the plugin can read them from process.env, then call start_session again. Alternatively set IG_SESSIONID or INSTAGRAM_SESSIONID to an existing Instagram sessionid cookie value.',
                });
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
                    inferenceClient: entry.session.inferenceClient,
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
    //   { login_id?: string, session_id?: string, code?: string | null }
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
            'Second leg of the login 2FA / device-approval round trip. Call immediately when the user sends a 6-digit Instagram 2FA code after `login` returned pending_2fa. Prefer passing the login_id from that pending_2fa result, but if it is unavailable, pass the code alone; the tool will resume the only active pending login. For pending_device_approval, pass login_id or session_id with code: null so the tool polls for the user approving on their other device. Returns success, failure, or still-pending.',
        parameters: {
            type: 'object',
            properties: {
                login_id: {
                    type: 'string',
                    description: 'The login_id returned by the pending login tool call. Optional when exactly one pending login is active.',
                },
                session_id: {
                    type: 'string',
                    description: 'Optional session_id returned by start_session/login. Used to find the pending login if login_id was lost.',
                },
                code: {
                    type: ['string', 'null'],
                    description: 'The 2FA code for pending_2fa. Null or omitted for pending_device_approval.',
                },
            },
            required: [],
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            await gcPendingLogins();

            const rawLoginId = params.login_id;
            const requestedLoginId =
                typeof rawLoginId === 'string' && rawLoginId.trim()
                    ? rawLoginId.trim()
                    : null;
            const rawSessionId = params.session_id;
            const requestedSessionId =
                typeof rawSessionId === 'string' && rawSessionId.trim()
                    ? rawSessionId.trim()
                    : null;
            const resolvedPending = resolvePendingLogin(requestedLoginId, requestedSessionId);
            if ('error' in resolvedPending) return resolvedPending.error;
            const { loginId, entry } = resolvedPending;

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
                            inferenceClient: sessionEntry.session.inferenceClient,
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
    // Tool: update_timer
    //
    // Updates the user-requested capture budget. Before the run starts, the
    // full 30/70 split is recomputed. During a live run, the stories cap is
    // immutable for that run and the changed time lands in feed/posts.
    //
    // Input:  { session_id: string, duration_minutes: number }
    // Output: JSON text block for updated state.
    // -----------------------------------------------------------------------
    const updateTimer: PluginTool = {
        name: 'update_timer',
        description:
            'Change the requested Kowalski run duration. Use when the user says "change it to 20 minutes" after start_session has created a session. Before capture starts, this recomputes the 30/70 stories/feed-posts split. During a live run, the stories cap stays immutable for that run and the changed time is applied to feed/posts; if elapsed time already meets or exceeds the new duration, the run is stopped immediately.',
        parameters: {
            type: 'object',
            properties: {
                session_id: {
                    type: 'string',
                    description: 'The id returned by start_session.',
                },
                duration_minutes: {
                    type: 'number',
                    minimum: 1,
                    maximum: 180,
                    description: 'New total capture budget in minutes.',
                },
            },
            required: ['session_id', 'duration_minutes'],
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            const sessionId =
                typeof params.session_id === 'string' && params.session_id.trim()
                    ? params.session_id.trim()
                    : null;
            if (!sessionId) {
                return textResult('update_timer: session_id is required.', true);
            }
            const entry = sessions.get(sessionId);
            if (!entry) {
                return textResult(`update_timer: session_id ${sessionId} not found.`, true);
            }

            const durationMinutes = readPositiveNumberField(params, 'duration_minutes');
            if (!durationMinutes || durationMinutes > 180) {
                return jsonTextResult({
                    status: 'pending_duration',
                    session_id: sessionId,
                    message:
                        'Ask the user for a new timer value in minutes, then call update_timer with duration_minutes between 1 and 180.',
                });
            }

            const phases = entry.session.runConfig.phases ?? ['stories', 'feed'];
            const digestRunning = entry.activeDigest?.status === 'running';
            const newTotalMs = Math.ceil(durationMinutes * 60_000);
            const durations = digestRunning
                ? (() => {
                    const storyCap =
                        entry.session.runConfig.storiesTimeoutMs ??
                        (phases.includes('stories') && phases.includes('feed')
                            ? Math.max(1, Math.round(newTotalMs * 0.3))
                            : phases.includes('stories')
                                ? newTotalMs
                                : undefined);
                    return {
                        maxDurationMs: newTotalMs,
                        storiesTimeoutMs: storyCap,
                        feedTimeoutMs: phases.includes('feed')
                            ? Math.max(1, newTotalMs - (storyCap ?? 0))
                            : undefined,
                    };
                })()
                : deriveRunDurations(durationMinutes, phases);
            entry.session.runConfig.maxDurationMs = durations.maxDurationMs;
            entry.session.runConfig.storiesTimeoutMs = durations.storiesTimeoutMs;
            entry.session.runConfig.feedTimeoutMs = durations.feedTimeoutMs;

            const elapsedMs = entry.activeDigest
                ? Math.max(0, Date.now() - entry.activeDigest.startedAt)
                : 0;
            let stopRequested = false;
            if (digestRunning && elapsedMs >= durations.maxDurationMs) {
                stopRequested = true;
                try {
                    const reason = entry.lastPhase === 'stories' ? 'timeout-stories' : 'timeout-feed';
                    RunManager.getInstance().stopRun(reason);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);
                    log.warn('[kowalski] update_timer: immediate stop after timer reduction failed', { msg });
                }
            }

            log.info('update_timer', {
                sessionId,
                durationMinutes,
                phases,
                digestRunning,
                elapsedMs,
                stopRequested,
                maxDurationMs: durations.maxDurationMs,
                storiesTimeoutMs: durations.storiesTimeoutMs,
                feedTimeoutMs: durations.feedTimeoutMs,
            });
            log.info('timer updated', {
                sessionId,
                durationMinutes,
                elapsedMs,
                totalCapMs: durations.maxDurationMs,
                storiesCapMs: durations.storiesTimeoutMs,
                feedCapMs: durations.feedTimeoutMs,
                stopRequested,
            });
            log.info(
                `[kowalski] timer updated: total=${formatMinutes(durations.maxDurationMs)}m elapsed=${formatMinutes(elapsedMs)}m stories=${formatMinutes(durations.storiesTimeoutMs ?? 0)}m feed/posts=${formatMinutes(durations.feedTimeoutMs ?? 0)}m stopRequested=${stopRequested}`
            );

            return jsonTextResult({
                status: 'timer_updated',
                session_id: sessionId,
                digest_status: entry.activeDigest?.status,
                duration_minutes: durationMinutes,
                elapsed_ms: elapsedMs,
                stop_requested: stopRequested,
                total_cap_ms: durations.maxDurationMs,
                stories_cap_ms: durations.storiesTimeoutMs,
                feed_cap_ms: durations.feedTimeoutMs,
                split: phases.includes('stories') && phases.includes('feed')
                    ? { stories_pct: 30, feed_pct: 70 }
                    : undefined,
                message: phases.includes('stories') && phases.includes('feed')
                    ? digestRunning
                        ? `Timer updated to ${durationMinutes} minutes: stories remains ${formatMinutes(durations.storiesTimeoutMs ?? 0)} min for this run, feed/posts is now ${formatMinutes(durations.feedTimeoutMs ?? 0)} min.${stopRequested ? ' Elapsed time already meets the new timer, so the run is stopping now.' : ''}`
                        : `Timer updated to ${durationMinutes} minutes: stories=${formatMinutes(durations.storiesTimeoutMs ?? 0)} min, feed/posts=${formatMinutes(durations.feedTimeoutMs ?? 0)} min.`
                    : phases.includes('stories')
                        ? `Timer updated to ${durationMinutes} minutes for stories.${stopRequested ? ' Elapsed time already meets the new timer, so the run is stopping now.' : ''}`
                        : `Timer updated to ${durationMinutes} minutes for feed/posts.${stopRequested ? ' Elapsed time already meets the new timer, so the run is stopping now.' : ''}`,
            });
        },
    };

    // -----------------------------------------------------------------------
    // Tool: run_digest
    //
    // Kicks off the Kowalski pipeline and waits for the completed/stopped
    // digest markdown before returning, so manual run_digest calls print to
    // the TUI without requiring a separate print_digest call.
    //
    // Auto-start paths (start_session/login/submit_verification_code) still
    // call startDigestForEntry without waitForCompletion so stop/status tools
    // remain usable while those background runs are active.
    //
    // Input:  { session_id: string }
    // Output: display-ready markdown, or a failed/pending JSON payload.
    // -----------------------------------------------------------------------
    const runDigest: PluginTool = {
        name: 'run_digest',
        description:
            'Manually run the Kowalski pipeline (stories + feed capture, extraction, digest generation), write the PDF/JSON artifacts, and return the display-ready markdown digest in this tool result. This call blocks until the run finishes, so no separate print_digest call is needed for manual run_digest. Normally start_session/login/submit_verification_code starts the digest automatically in the background once Instagram auth is verified. HARD TIMEOUTS: derived from start_session duration_minutes; with both phases, stories get 30% and feed/posts get 70%. On timeout the digest finalizes with `aborted: true, abortReason: "timeout-stories"|"timeout-feed"`.',
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
            return startDigestForEntry(sessionId, entry, 'run_digest', {}, {
                waitForCompletion: true,
            });
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
            'Return the latest run phase and last ~20 pipeline events for a session. Useful to check progress on a long-running run_digest call. When digest_status is completed or stopped, immediately call print_digest with the returned session_id/record_id to print the display-ready markdown digest to the user.',
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
                const fallback = findLatestDigestSession(sessionId);
                if (fallback) {
                    return jsonTextResult(buildSessionStatusPayload(fallback, sessionId));
                }
                return textResult(`get_session_status: session_id ${sessionId} not found.`, true);
            }

            if (!entry.activeDigest) {
                const fallback = findLatestDigestSession(sessionId);
                if (fallback) {
                    return jsonTextResult(buildSessionStatusPayload(fallback, sessionId));
                }
            }

            return jsonTextResult(buildSessionStatusPayload(entry));
        },
    };

    // -----------------------------------------------------------------------
    // Tool: print_digest
    //
    // Returns the completed/stopped digest as display-ready markdown. This is
    // intentionally a plain text result, not JSON, so emoji and markdown are
    // preserved for the OpenClaw TUI/chat surface.
    // -----------------------------------------------------------------------
    const printDigest: PluginTool = {
        name: 'print_digest',
        description:
            'Poll for and print a Kowalski digest. Safe to call repeatedly: while the digest is still running/idle, this returns a small `{ status: "pending", silent: true }` JSON payload that should not be shown to the user. Once the digest is completed or stopped, this returns display-ready markdown with emoji and artifact paths; return that markdown to the user verbatim. If no session_id or record_id is provided, prints the newest ready in-memory digest, or the newest saved analysis record. This call auto-ends the session after a successful print.',
        parameters: {
            type: 'object',
            properties: {
                session_id: {
                    type: 'string',
                    description: 'The active session id returned by start_session / get_session_status.',
                },
                record_id: {
                    type: 'string',
                    description: 'The digest record id returned by get_session_status. Optional when session_id still points at a completed/stopped digest.',
                },
            },
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            const sessionId =
                typeof params.session_id === 'string' && params.session_id.trim()
                    ? params.session_id.trim()
                    : null;
            const recordId =
                typeof params.record_id === 'string' && params.record_id.trim()
                    ? params.record_id.trim()
                    : null;

            let text: string | undefined;
            let entryToEnd: SessionEntry | undefined;
            if (!sessionId && !recordId) {
                const latest = findLatestDigestSession();
                if (latest?.activeDigest) {
                    const ad = latest.activeDigest;
                    if (ad.status === 'failed') {
                        return jsonTextResult({
                            status: 'failed',
                            digest_status: 'failed',
                            session_id: latest.sessionId,
                            silent: false,
                            digest_error: ad.errorMessage ?? 'Digest failed.',
                            message: 'Digest failed. Tell the user this error instead of scheduling another print_digest poll.',
                        }, true);
                    }
                    if (ad.status !== 'completed' && ad.status !== 'stopped') {
                        return jsonTextResult({
                            status: 'pending',
                            digest_status: ad.status,
                            session_id: latest.sessionId,
                            digest_started_at: new Date(ad.startedAt).toISOString(),
                            digest_elapsed_ms: Date.now() - ad.startedAt,
                            silent: true,
                            recommended_next_poll_ms: 30_000,
                            message: pendingDigestMessage(),
                        });
                    }
                    text = ad.resultText;
                    entryToEnd = latest;
                }
                if (!text) {
                    const latestRecordId = await findLatestSavedRecordId();
                    if (latestRecordId) {
                        const saved = await readSavedDigest(latestRecordId);
                        if (typeof saved === 'string') text = saved;
                        else return saved.error;
                    }
                }
            }
            if (sessionId) {
                const entry = sessions.get(sessionId);
                if (!entry) {
                    if (!recordId) {
                        const fallback = findLatestDigestSession(sessionId);
                        if (!fallback) {
                            return textResult(`print_digest: session_id ${sessionId} not found.`, true);
                        }
                        const ad = fallback.activeDigest!;
                        if (ad.status === 'failed') {
                            return jsonTextResult({
                                status: 'failed',
                                digest_status: 'failed',
                                session_id: fallback.sessionId,
                                redirected_from_session_id: sessionId,
                                silent: false,
                                digest_error: ad.errorMessage ?? 'Digest failed.',
                                message: 'Digest failed. Tell the user this error instead of scheduling another print_digest poll.',
                            }, true);
                        }
                        if (ad.status !== 'completed' && ad.status !== 'stopped') {
                            return jsonTextResult({
                                status: 'pending',
                                digest_status: ad.status,
                                session_id: fallback.sessionId,
                                redirected_from_session_id: sessionId,
                                digest_started_at: new Date(ad.startedAt).toISOString(),
                                digest_elapsed_ms: Date.now() - ad.startedAt,
                                silent: true,
                                recommended_next_poll_ms: 30_000,
                                message: pendingDigestMessage('The requested session has no active digest, but this session is still running. Use this session_id for the next explicit print/status check.'),
                            });
                        }
                        text = ad.resultText;
                        entryToEnd = fallback;
                    }
                } else {
                    const ad = entry.activeDigest;
                    if (!ad) {
                        const fallback = findLatestDigestSession(sessionId);
                        if (fallback) {
                            const fallbackAd = fallback.activeDigest!;
                            if (fallbackAd.status === 'failed') {
                                return jsonTextResult({
                                    status: 'failed',
                                    digest_status: 'failed',
                                    session_id: fallback.sessionId,
                                    redirected_from_session_id: sessionId,
                                    silent: false,
                                    digest_error: fallbackAd.errorMessage ?? 'Digest failed.',
                                    message: 'Digest failed. Tell the user this error instead of scheduling another print_digest poll.',
                                }, true);
                            }
                            if (
                                fallbackAd.status !== 'completed' &&
                                fallbackAd.status !== 'stopped'
                            ) {
                                return jsonTextResult({
                                    status: 'pending',
                                    digest_status: fallbackAd.status,
                                    session_id: fallback.sessionId,
                                    redirected_from_session_id: sessionId,
                                    digest_started_at: new Date(fallbackAd.startedAt).toISOString(),
                                    digest_elapsed_ms: Date.now() - fallbackAd.startedAt,
                                    silent: true,
                                    recommended_next_poll_ms: 30_000,
                                    message: pendingDigestMessage('The requested session has no active digest, but this session is still running. Use this session_id for the next explicit print/status check.'),
                                });
                            }
                            text = fallbackAd.resultText;
                            entryToEnd = fallback;
                        }
                    }
                    if (!ad && !text) {
                        return jsonTextResult({
                            status: 'pending',
                            digest_status: 'idle',
                            session_id: sessionId,
                            silent: true,
                            recommended_next_poll_ms: 30_000,
                            message: 'No digest has started on this session yet. Stay silent and poll again only if the workflow has already started.',
                        });
                    }
                    if (ad) {
                        if (ad.status === 'failed') {
                            return jsonTextResult({
                                status: 'failed',
                                digest_status: 'failed',
                                session_id: sessionId,
                                silent: false,
                                digest_error: ad.errorMessage ?? 'Digest failed.',
                                message: 'Digest failed. Tell the user this error instead of scheduling another print_digest poll.',
                            }, true);
                        }
                        if (ad.status !== 'completed' && ad.status !== 'stopped') {
                            return jsonTextResult({
                                status: 'pending',
                                digest_status: ad.status,
                                session_id: sessionId,
                                digest_started_at: new Date(ad.startedAt).toISOString(),
                                digest_elapsed_ms: Date.now() - ad.startedAt,
                                silent: true,
                                recommended_next_poll_ms: 30_000,
                                message: pendingDigestMessage(),
                            });
                        }
                        if (recordId && ad.recordId && recordId !== ad.recordId) {
                            return textResult(
                                `print_digest: record_id mismatch for session ${sessionId}; expected ${ad.recordId}, got ${recordId}.`,
                                true
                            );
                        }
                        text = ad.resultText;
                        entryToEnd = entry;
                    }
                }
            }

            if (!text && recordId) {
                const saved = await readSavedDigest(recordId);
                if (typeof saved === 'string') text = saved;
                else return saved.error;
            }

            if (!text) {
                return textResult(
                    'print_digest: no active completed digest or saved analysis record was found. Provide session_id for an active completed digest, or record_id for a saved analysis record.',
                    true
                );
            }

            if (entryToEnd) {
                if (entryToEnd.activeDigest) entryToEnd.activeDigest.resultDelivered = true;
                try { entryToEnd.controller.abort(); } catch { /* ignore */ }
                try {
                    const ctx = entryToEnd.session.browser?.context;
                    if (ctx) await ctx.close();
                } catch (err) {
                    log.warn('print_digest: auto-end browser close failed', err);
                }
                sessions.delete(entryToEnd.sessionId);
            }

            return textResult(text);
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
    //   - In-memory       (active sessions, pending-login browsers, usage stats)
    //
    // Does NOT touch:
    //   - The plugin's OpenClaw config (downloadsDir, userName, location,
    //     browserProfileDir override). Those are OpenClaw-managed; the user
    //     clears them via `openclaw config unset`.
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
            'Full factory reset: closes all active sessions + pending-login browsers, deletes the browser profile (login cookies included), scratch dir, and all analysis records. Requires `confirm: true` — call without it first to preview what will be wiped. Does NOT delete digest PDFs already written to Downloads, and does NOT clear OpenClaw plugin config.',
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
                        'Will NOT touch: OpenClaw plugin config or digest PDFs already in Downloads.'
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
                (errors.length
                    ? '\n\nErrors:\n' + errors.map((e) => `  - ${e}`).join('\n')
                    : '') +
                '\n\nNext step: call start_session. You will need to log in again (cookies are gone).';

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
            'Request a graceful stop of an in-flight run_digest. Session id is optional; if omitted or stale, this acts as a global kill switch for the singleton runner by writing the plugin-level stop marker. The run finalizes and produces a partial digest tagged aborted: true, abortReason: user-stop. Use this immediately when the user says "stop the run" / "cancel the digest" / "I\'ve seen enough".',
        parameters: {
            type: 'object',
            properties: {
                session_id: {
                    type: 'string',
                    description: 'The id returned by start_session. Optional; omit it when the user asks to stop but the active session id is unavailable or stale.',
                },
            },
            additionalProperties: false,
        },
        execute: async (_callId, params) => {
            const sessionId =
                typeof params.session_id === 'string' && params.session_id.trim()
                    ? params.session_id.trim()
                    : null;
            const entry = sessionId ? sessions.get(sessionId) : undefined;

            // Belt-and-suspenders: write the STOP_REQUESTED marker AND call
            // RunManager.stopRun() directly in-process.
            //   - Marker: resilient to out-of-band stops (e.g. user types
            //     `touch …/STOP_REQUESTED` in a terminal, or this tool is
            //     invoked across multiple runs). RunManager polls it on
            //     a 3s setInterval.
            //   - Direct call: fires instantly (no 3s poll latency) and,
            //     thanks to the AbortController integration in stopRun,
            //     tears down any in-flight inference request immediately.
            // Either mechanism alone would work; together they give the
            // fastest, most reliable stop.
            const markerDir = entry?.session.scratchDir ?? scratchDir;
            const markerPath = path.join(markerDir, 'STOP_REQUESTED');
            try {
                fs.mkdirSync(markerDir, { recursive: true });
                fs.writeFileSync(markerPath, '');
            } catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                return textResult(`stop_run: failed to write stop marker at ${markerPath}: ${msg}`, true);
            }

            try {
                RunManager.getInstance().stopRun('user-stop');
            } catch (err) {
                // Non-fatal: the marker poller is the fallback.
                const msg = err instanceof Error ? err.message : String(err);
                log.warn('[kowalski] stop_run: RunManager.stopRun() threw (marker still written)', { msg });
            }

            const fallbackLine =
                sessionId && !entry
                    ? ` The provided session_id (${sessionId}) was not in the registry, so I used the global stop marker instead.`
                    : !sessionId
                        ? ' No session_id was provided, so I used the global stop marker.'
                        : '';
            return textResult(
                shouldEnableScheduledPolling()
                    ? `Stop requested.${fallbackLine} The run will finalize within ~30 seconds and produce a partial digest/PDF if captures exist. Keep polling print_digest/get_session_status until the stopped or completed digest is ready, then print the returned markdown in the TUI.`
                    : `Stop requested.${fallbackLine} The run will finalize within ~30 seconds and produce a partial digest/PDF if captures exist. Do not create OpenClaw cron/scheduled follow-up turns by default; call print_digest or get_session_status explicitly when the user asks for the stopped/partial digest.`
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

            for (const [id, pending] of pendingLogins) {
                if (pending.sessionId !== sessionId) continue;
                try {
                    await pending.context.close();
                } catch {
                    /* ignore */
                }
                pendingLogins.delete(id);
            }

            sessions.delete(sessionId);
            return textResult('Session ended.');
        },
    };

    api.registerTool(startSession);
    api.registerTool(loginTool);
    api.registerTool(submitVerificationCode);
    api.registerTool(updateTimer);
    api.registerTool(runDigest);
    api.registerTool(getSessionStatus);
    api.registerTool(printDigest);
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
        activeSessions: sessions.size,
        pendingLogins: pendingLogins.size,
        registrations: globalState.registrations,
    });

    return () => {
        globalState.registrations = Math.max(0, globalState.registrations - 1);
        log.info('[kowalski] plugin teardown: preserving process-global session state', {
            activeSessions: sessions.size,
            pendingLogins: pendingLogins.size,
            registrations: globalState.registrations,
        });
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
