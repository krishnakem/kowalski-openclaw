/**
 * NetworkMonitor — lightweight online check for the current host network.
 *
 * A run and a digest generation both require outbound connectivity. This
 * helper performs a short generic probe so we can fail fast with a typed
 * "offline" error instead of letting inference retry loops burn attempts on a
 * dead connection. Provider health and billing are handled by the active
 * inference backend.
 */

const PROBE_URL = process.env.KOWALSKI_CONNECTIVITY_PROBE_URL || 'https://www.gstatic.com/generate_204';
const PROBE_TIMEOUT_MS = 2000;

export async function isOnline(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        // Any HTTP response proves DNS + TCP + TLS reached the network. Only network-layer failures
        // (DNS, connection refused, timeout) mean we're truly offline.
        await fetch(PROBE_URL, { method: 'HEAD', signal: controller.signal });
        return true;
    } catch {
        return false;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Background poller that probes connectivity every `intervalMs` and calls
 * `onOffline` the first time the probe fails. Returns a stop() function.
 *
 * We don't rely on `navigator.onLine` events alone because Chromium on macOS
 * can lag by many seconds when WiFi toggles. A generic connectivity probe gives
 * us a provider-independent way to detect loss quickly.
 */
export function startOfflineWatchdog(
    onOffline: () => void,
    intervalMs = 1000
): () => void {
    let stopped = false;
    let consecutiveFailures = 0;
    // Require three consecutive failures before tripping. Stage 3.5 had a live
    // run aborted by a single dropped probe mid-feed-phase; three checks
    // (~200ms apart once failing) still fire in under a second but survive a
    // lone packet loss or a WiFi stutter.
    const REQUIRED_FAILURES = 3;

    const tick = async () => {
        while (!stopped) {
            const ok = await isOnline();
            if (stopped) return;
            if (ok) {
                consecutiveFailures = 0;
                await new Promise(r => setTimeout(r, intervalMs));
            } else {
                consecutiveFailures++;
                if (consecutiveFailures >= REQUIRED_FAILURES) {
                    stopped = true;
                    onOffline();
                    return;
                }
                // Don't wait the full interval between failures — when the OS
                // reports no route, DNS fails in <100ms, so a quick re-probe
                // confirms within ~200ms rather than ~1s.
                await new Promise(r => setTimeout(r, 200));
            }
        }
    };
    tick();

    return () => { stopped = true; };
}

export function isNetworkError(err: unknown): boolean {
    if (!err) return false;
    const e = err as { name?: string; code?: string; message?: string; cause?: { code?: string } };
    // Per-request timeout aborts land here too — treat them as network-suspect
    // so the caller runs an isOnline() probe to confirm.
    if (e.name === 'TimeoutError' || e.name === 'AbortError') return true;
    const code = e.code || e.cause?.code || '';
    if (['ENOTFOUND', 'EAI_AGAIN', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENETUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_SOCKET'].includes(code)) {
        return true;
    }
    const msg = (e.message || '').toLowerCase();
    return /fetch failed|getaddrinfo|network|enotfound|econnrefused|timeout/.test(msg);
}

export const OFFLINE_ERROR = 'OFFLINE';
