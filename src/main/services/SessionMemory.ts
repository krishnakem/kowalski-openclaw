/**
 * SessionMemory - Cross-Session Learning Service
 *
 * Persists compact session summaries to disk and generates LLM-ready digests.
 * Enables Kowalski to learn from past browsing sessions:
 * - Which interests produce the most captures
 * - Which phases are most productive
 * - Where stagnation commonly occurs
 *
 * Storage: {userData}/session_memory/summaries.json
 * Uses atomic write pattern (write temp → rename) for safety.
 *
 * Cost: $0 (no API calls, file I/O only)
 */

import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { SessionSummary } from '../../types/session-memory.js';

const MAX_SUMMARIES = 20;
const DIGEST_SUMMARIES = 5;

export class SessionMemory {
    private storagePath: string;
    private summaries: SessionSummary[] = [];

    constructor() {
        const userDataPath = app.getPath('userData');
        this.storagePath = path.join(userDataPath, 'session_memory', 'summaries.json');
    }

    /**
     * Load session summaries from disk.
     * Call this before a browsing session starts.
     */
    async loadMemory(): Promise<SessionSummary[]> {
        try {
            const data = await fs.promises.readFile(this.storagePath, 'utf-8');
            this.summaries = JSON.parse(data) as SessionSummary[];
            console.log(`🧠 Loaded ${this.summaries.length} session memories`);
        } catch {
            // File doesn't exist yet or is corrupted - start fresh
            this.summaries = [];
        }
        return this.summaries;
    }

    /**
     * Save a session summary to disk.
     * Call this after a browsing session completes.
     * Trims to MAX_SUMMARIES, keeping most recent.
     */
    async saveSession(summary: SessionSummary): Promise<void> {
        this.summaries.push(summary);

        // Keep only the most recent summaries
        if (this.summaries.length > MAX_SUMMARIES) {
            this.summaries = this.summaries.slice(-MAX_SUMMARIES);
        }

        // Atomic write: temp file → rename
        const dir = path.dirname(this.storagePath);
        const tempPath = this.storagePath + '.tmp';

        try {
            await fs.promises.mkdir(dir, { recursive: true });
            await fs.promises.writeFile(tempPath, JSON.stringify(this.summaries, null, 2));
            await fs.promises.rename(tempPath, this.storagePath);
            console.log(`🧠 Saved session memory (${this.summaries.length} sessions)`);
        } catch (err) {
            console.error('Failed to save session memory:', err);
        }
    }

    /**
     * Reset session memory — delete the file and clear in-memory state.
     */
    async resetMemory(): Promise<void> {
        this.summaries = [];
        try {
            await fs.promises.unlink(this.storagePath);
            console.log('🧠 Session memory reset');
        } catch {
            // File didn't exist — that's fine
        }
    }

    /**
     * Generate a compact LLM-ready digest from recent sessions.
     * Returns ~150 tokens summarizing patterns and lessons learned.
     */
    generateDigest(): string {
        const recent = this.summaries.slice(-DIGEST_SUMMARIES);
        if (recent.length === 0) return '';

        const lines: string[] = [`SESSION MEMORY (last ${recent.length} sessions):`];

        // Phase effectiveness
        const phaseStats = this.getPhaseStats(recent);
        if (phaseStats.length > 0) {
            const phaseSummary = phaseStats
                .map(p => `${p.phase} ${p.avgTimePct.toFixed(0)}% time → ${p.avgCapturesPct.toFixed(0)}% captures`)
                .join(', ');
            lines.push(`- Phase split: ${phaseSummary}`);
        }

        // Stagnation patterns
        const stagnationInfo = this.getStagnationPatterns(recent);
        if (stagnationInfo) {
            lines.push(`- ${stagnationInfo}`);
        }

        // Session averages
        const avgCaptures = recent.reduce((sum, s) => sum + s.totalCaptures, 0) / recent.length;
        const avgActions = recent.reduce((sum, s) => sum + s.totalActions, 0) / recent.length;
        lines.push(`- Avg session: ${avgCaptures.toFixed(1)} captures in ${avgActions.toFixed(0)} actions`);

        return lines.join('\n');
    }

    private getPhaseStats(summaries: SessionSummary[]): Array<{
        phase: string;
        avgTimePct: number;
        avgCapturesPct: number;
    }> {
        const phaseMap = new Map<string, { totalTimePct: number; totalCapturesPct: number; count: number }>();

        for (const session of summaries) {
            const totalDuration = session.phaseBreakdown.reduce((sum, p) => sum + p.durationMs, 0) || 1;
            const totalCaptures = session.phaseBreakdown.reduce((sum, p) => sum + p.capturesProduced, 0) || 1;

            for (const phase of session.phaseBreakdown) {
                const existing = phaseMap.get(phase.phase) || { totalTimePct: 0, totalCapturesPct: 0, count: 0 };
                existing.totalTimePct += (phase.durationMs / totalDuration) * 100;
                existing.totalCapturesPct += (phase.capturesProduced / totalCaptures) * 100;
                existing.count++;
                phaseMap.set(phase.phase, existing);
            }
        }

        return Array.from(phaseMap.entries()).map(([phase, data]) => ({
            phase,
            avgTimePct: data.totalTimePct / data.count,
            avgCapturesPct: data.totalCapturesPct / data.count
        }));
    }

    private getStagnationPatterns(summaries: SessionSummary[]): string | null {
        const allEvents = summaries.flatMap(s => s.stagnationEvents);
        if (allEvents.length === 0) return null;

        // Find common stagnation scroll positions
        const scrollYValues = allEvents.map(e => e.scrollY);
        const avgStagnationY = scrollYValues.reduce((a, b) => a + b, 0) / scrollYValues.length;

        // Find most effective recovery action
        const recoverySuccess = new Map<string, { success: number; total: number }>();
        for (const event of allEvents) {
            const existing = recoverySuccess.get(event.recoveryAction) || { success: 0, total: 0 };
            existing.total++;
            if (event.recoveredSuccessfully) existing.success++;
            recoverySuccess.set(event.recoveryAction, existing);
        }

        const bestRecovery = Array.from(recoverySuccess.entries())
            .sort((a, b) => (b[1].success / b[1].total) - (a[1].success / a[1].total))
            .map(([action, stats]) => `${action} (${Math.round(stats.success / stats.total * 100)}% effective)`)
            .slice(0, 2)
            .join(', ');

        return `Stagnation: avg at ${Math.round(avgStagnationY)}px scrollY, recovery: ${bestRecovery}`;
    }

}
