/**
 * Plugin-side session registry.
 *
 * Keyed by the session_id we mint at start_session time. Holds the
 * KowalskiSession, its AbortController, a bounded ring buffer of recent
 * events (for get_session_status), and the last run-phase emitted by
 * RunManager (same source).
 *
 * This lives in the plugin layer on purpose — KowalskiSession (src/core/)
 * is frozen at its Stage 2 contract. Per-plugin bookkeeping goes in a
 * sidecar map rather than by extending the session interface.
 */

import type { KowalskiSession } from '../core/KowalskiSession.js';

export interface BufferedEvent {
    event: string;
    payload: unknown;
    ts: number;
}

/**
 * In-flight digest bookkeeping. Populated by `run_digest` when it kicks
 * off the background promise; `get_session_status` reads it to report
 * progress and to hand back the final result once the run completes.
 *
 * Non-blocking `run_digest` is what makes `stop_run` actually stop a
 * live run — OpenClaw serializes tool dispatch per plugin, so as long
 * as `run_digest` holds the gateway, no other tool call can fire.
 * Returning immediately frees the dispatcher for `stop_run` / status
 * polls / anything else the user needs mid-run.
 */
export interface ActiveDigest {
    startedAt: number;
    status: 'running' | 'completed' | 'failed' | 'stopped';
    /** Display-ready markdown returned by `print_digest`. */
    resultText?: string;
    /** Record id for the completed/stopped digest. */
    recordId?: string;
    /** Path to the persisted JSON analysis record. */
    recordPath?: string;
    /** Path to the exported text-only PDF, when PDF export succeeds. */
    pdfPath?: string;
    /** Error message when status === 'failed'. */
    errorMessage?: string;
    /** True once the digest result has been delivered to the agent at least once. */
    resultDelivered?: boolean;
    /** Teardown handle for the status ticker. Set/cleared by run_digest. */
    tickerHandle?: NodeJS.Timeout | null;
    /** Teardown for the 'run-phase' listener. */
    detachPhaseListener?: (() => void) | null;
}

export interface SessionEntry {
    sessionId: string;
    session: KowalskiSession;
    controller: AbortController;
    events: BufferedEvent[];
    lastPhase: string | null;
    createdAt: number;
    activeDigest?: ActiveDigest;
}

const EVENT_BUFFER_SIZE = 20;

export function createRegistry(): Map<string, SessionEntry> {
    return new Map<string, SessionEntry>();
}

/**
 * Wire every session.events emission into the ring buffer. Also tracks
 * the last 'run-phase' payload so get_session_status can surface it as
 * a dedicated field.
 */
export function attachEventBuffer(entry: SessionEntry): void {
    const names = [
        'frame',
        'screencastEnded',
        'loginScreencastReady',
        'loginSuccess',
        'run-started',
        'run-phase',
        'analysis-ready',
        'analysis-error',
        'run-complete',
    ] as const;

    for (const name of names) {
        entry.session.events.on(name, (payload?: unknown) => {
            const sanitized = name === 'frame' ? { note: 'frame omitted from buffer' } : payload;
            entry.events.push({ event: name, payload: sanitized, ts: Date.now() });
            if (entry.events.length > EVENT_BUFFER_SIZE) {
                entry.events.shift();
            }
            if (name === 'run-phase' && typeof payload === 'object' && payload !== null) {
                const phase = (payload as { phase?: unknown }).phase;
                if (typeof phase === 'string') entry.lastPhase = phase;
            }
            if (name === 'run-started') entry.lastPhase = 'starting';
            if (name === 'run-complete') entry.lastPhase = 'complete';
        });
    }
}
