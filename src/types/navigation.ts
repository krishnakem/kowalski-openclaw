/**
 * Navigation Types
 *
 * Minimal types for the VisionAgent browsing system.
 */

/**
 * High-level phases of the Instagram browsing session.
 */
export type BrowsingPhase = 'stories' | 'feed' | 'complete';

/**
 * Configuration for the navigation loop.
 */
export interface NavigationLoopConfig {
    maxDurationMs: number;
    actionDelayMs?: [number, number];
    rawDir?: string;  // Directory for raw screenshot dumps (three-agent pipeline)
    phases?: ('stories' | 'feed')[];  // Which phases to run (default: both)
    onPhaseChange?: (phase: 'stories' | 'feed', info?: { maxDurationMs?: number }) => void;
}
