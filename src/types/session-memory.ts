/**
 * Session Memory Types - Cross-Session Learning
 *
 * Enables Kowalski to learn from past browsing sessions.
 * After each session, a compact summary is persisted. Before the next session,
 * recent summaries are loaded and distilled into a ~150 token LLM-ready digest.
 *
 * Storage: File-based in {userData}/session_memory/summaries.json
 */

import { BrowsingPhase } from './navigation.js';

/**
 * How productive a specific interest search was.
 */
export interface InterestResult {
    interest: string;
    captureCount: number;
    searchTimeMs: number;
    quality: 'low' | 'medium' | 'high';
}

/**
 * Breakdown of time and productivity per browsing phase.
 */
export interface PhaseBreakdown {
    phase: BrowsingPhase;
    durationMs: number;
    capturesProduced: number;
}

/**
 * A stagnation event recorded during a session.
 */
export interface StagnationEvent {
    scrollY: number;
    phase: string;
    recoveryAction: string;
    recoveredSuccessfully: boolean;
}

/**
 * Compact summary of a completed browsing session.
 * Written after each session, read before the next.
 */
export interface SessionSummary {
    id: string;
    timestamp: number;
    durationMs: number;

    /** Per-interest productivity */
    interestResults: InterestResult[];

    /** Time/captures per phase */
    phaseBreakdown: PhaseBreakdown[];

    /** Where and how Kowalski got stuck */
    stagnationEvents: StagnationEvent[];

    /** Final session stats */
    totalCaptures: number;
    totalActions: number;
    uniqueContentRatio: number;
}
