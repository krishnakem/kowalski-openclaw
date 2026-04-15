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

import { createKowalskiSession } from '../core/KowalskiSession.js';
import { BrowserManager } from '../main/services/BrowserManager.js';
import { RunManager } from '../main/services/RunManager.js';
import { UsageService } from '../main/services/UsageService.js';
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
    // Tool: login  (optional — requires user allowlist)
    //
    // Opens a headful Chromium window against the configured profile dir
    // and waits for the user to close the window after logging in. Wrapped
    // in a 10-minute timeout — the tool returns an error result if the
    // window is still open at that point.
    //
    // Input:  (none)
    // Output: text block confirming success or an error payload
    // -----------------------------------------------------------------------
    const LOGIN_TIMEOUT_MS = 10 * 60 * 1000;
    const loginTool: PluginTool = {
        name: 'login',
        description:
            'Open a headful Chromium window so the user can log into Instagram. Cookies persist into the configured browser profile dir for subsequent runs. Times out after 10 minutes if the user never closes the window. Only needed when start_session reports logged_in: false.',
        parameters: {
            type: 'object',
            properties: {},
            additionalProperties: false,
        },
        execute: async () => {
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
                const header =
                    `# Kowalski digest\n\n` +
                    `- record id: ${result.record.id}\n` +
                    `- saved to: ${recordPath}\n` +
                    `- captures: extracted=${result.counts.extracted}, skipped=${result.counts.skipped}, failed=${result.counts.failed}\n` +
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
    api.registerTool(runDigest);
    api.registerTool(getSessionStatus);
    api.registerTool(resetMemory);
    api.registerTool(endSession);

    log.info('Kowalski plugin registered', {
        browserProfileDir,
        scratchDir,
        outputDir,
        tools: 6,
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
