/**
 * NetworkMonitor — lightweight online check for the current host network.
 *
 * A run and a digest generation both require outbound connectivity. This
 * helper performs a short generic probe so we can fail fast with a typed
 * "offline" error instead of letting inference retry loops burn attempts on a
 * dead connection. Provider health and billing are handled by the active
 * inference backend.
 */

const DEFAULT_PROBE_URLS = [
    'https://www.gstatic.com/generate_204',
    'https://www.cloudflare.com/cdn-cgi/generate_204',
    'https://www.instagram.com/',
];
const PROBE_URLS = (process.env.KOWALSKI_CONNECTIVITY_PROBE_URLS || process.env.KOWALSKI_CONNECTIVITY_PROBE_URL || '')
    .split(',')
    .map((url) => url.trim())
    .filter(Boolean);
const CONNECTIVITY_PROBE_URLS = PROBE_URLS.length > 0 ? PROBE_URLS : DEFAULT_PROBE_URLS;
const PROBE_TIMEOUT_MS = Number(process.env.KOWALSKI_CONNECTIVITY_PROBE_TIMEOUT_MS || 4000);

export async function isOnline(): Promise<boolean> {
    for (const url of CONNECTIVITY_PROBE_URLS) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
        try {
            // Any HTTP response proves DNS + TCP + TLS reached the network. Only
            // network-layer failures on every probe mean we're truly offline.
            await fetch(url, { method: 'HEAD', signal: controller.signal });
            return true;
        } catch {
            // Try the next probe before declaring the whole host offline.
        } finally {
            clearTimeout(timer);
        }
    }
    return false;
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
    intervalMs = 5000
): () => void {
    let stopped = false;
    let consecutiveFailures = 0;
    // Require a sustained outage before tripping. Browse/model traffic can be
    // healthy while a single generic probe endpoint is slow or blocked; the
    // agent and extractor still throw immediately on their own network errors.
    const REQUIRED_FAILURES = Number(process.env.KOWALSKI_OFFLINE_WATCHDOG_FAILURES || 6);

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
                await new Promise(r => setTimeout(r, intervalMs));
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
