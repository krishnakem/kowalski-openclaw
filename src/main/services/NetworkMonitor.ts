/**
 * NetworkMonitor — lightweight online check for the Anthropic API.
 *
 * A run and a digest generation both require outbound connectivity to
 * api.anthropic.com. This helper performs a short HEAD probe so we can fail
 * fast with a typed "offline" error instead of letting the vision/digest
 * retry loops burn attempts on a dead connection.
 */

const PROBE_URL = 'https://api.anthropic.com/v1/messages';
const PROBE_TIMEOUT_MS = 2000;

export async function isOnline(): Promise<boolean> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
    try {
        // HEAD is not allowed on /v1/messages, but any HTTP response (even 4xx)
        // proves DNS + TCP + TLS reached Anthropic. Only network-layer failures
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
 * can lag by many seconds when WiFi toggles — actively pinging Anthropic is
 * the only reliable way to detect the loss within ~1 second.
 */
export function startOfflineWatchdog(
    onOffline: () => void,
    intervalMs = 1000
): () => void {
    let stopped = false;
    let consecutiveFailures = 0;
    const REQUIRED_FAILURES = 2; // guard against a single dropped packet

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
export const CREDITS_DEPLETED_ERROR = 'CREDITS_DEPLETED';

/**
 * Parse an Anthropic API error body and return true if it's a
 * credit-balance-exhausted error. Anthropic responds with 400 and a body
 * like `{"type":"error","error":{"type":"invalid_request_error","message":
 * "Your credit balance is too low to access the Claude API..."}}`.
 */
export function isCreditsDepletedError(status: number, body: string): boolean {
    if (status !== 400 && status !== 403) return false;
    const lower = body.toLowerCase();
    return lower.includes('credit balance') || lower.includes('credit_balance');
}
