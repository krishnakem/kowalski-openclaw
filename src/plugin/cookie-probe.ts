/**
 * Instagram login probe.
 *
 * Playwright's persistent context stores cookies in a Chromium-format
 * SQLite DB at `<profileDir>/Default/Cookies`. We read it directly (the
 * context isn't open yet when start_session runs) and check for a
 * non-expired `sessionid` cookie on `.instagram.com`.
 *
 * Ported from the pre-refactor main.ts's TODO #7 breadcrumb. Uses
 * better-sqlite3 which is already a runtime dep. Any failure — DB missing,
 * schema drift, file locked — returns `logged_in: 'unknown'` so the agent
 * falls back to calling `login`.
 */

import fs from 'node:fs';
import path from 'node:path';
import Database, { type Database as DatabaseHandle } from 'better-sqlite3';

export type LoginProbeResult =
    | { logged_in: true; expiresAt: number | null }
    | { logged_in: false; reason: 'no-cookie' | 'expired' }
    | { logged_in: 'unknown'; reason: string };

// Chromium stores `expires_utc` as microseconds since 1601-01-01. Convert
// to a millisecond Unix timestamp, or null if the cookie is session-only.
function chromiumTimeToUnixMs(expiresUtc: number | bigint): number | null {
    const n = typeof expiresUtc === 'bigint' ? Number(expiresUtc) : expiresUtc;
    if (!n) return null;
    const CHROMIUM_EPOCH_DIFF_MS = 11644473600000;
    return Math.floor(n / 1000) - CHROMIUM_EPOCH_DIFF_MS;
}

export function probeInstagramLogin(browserProfileDir: string): LoginProbeResult {
    const cookiesPath = path.join(browserProfileDir, 'Default', 'Cookies');
    if (!fs.existsSync(cookiesPath)) {
        return { logged_in: false, reason: 'no-cookie' };
    }

    let db: DatabaseHandle | null = null;
    try {
        db = new Database(cookiesPath, { readonly: true, fileMustExist: true });
        const row = db
            .prepare(
                `SELECT expires_utc FROM cookies
                 WHERE host_key = ? AND name = 'sessionid'
                 ORDER BY expires_utc DESC LIMIT 1`
            )
            .get('.instagram.com') as { expires_utc: number | bigint } | undefined;

        if (!row) return { logged_in: false, reason: 'no-cookie' };

        const expiresAt = chromiumTimeToUnixMs(row.expires_utc);
        if (expiresAt !== null && expiresAt < Date.now()) {
            return { logged_in: false, reason: 'expired' };
        }
        return { logged_in: true, expiresAt };
    } catch (err) {
        return {
            logged_in: 'unknown',
            reason: err instanceof Error ? err.message : String(err),
        };
    } finally {
        try {
            db?.close();
        } catch {
            // swallow — readonly handle close failures are not actionable
        }
    }
}
