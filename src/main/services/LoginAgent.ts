/**
 * LoginAgent — Stage 6 agentic Instagram login.
 *
 * Extends BaseVisionAgent so the login loop reuses the same
 * screenshot → label → LLM → action cycle that StoriesAgent and
 * FeedAgent use. Adds a handful of login-specific action names
 * (fill_username, fill_password, emit_pending_2fa,
 * emit_pending_device_approval, escalate_to_human) that are handled
 * by an overridden executeAction — the base class's action dispatcher
 * falls through to "unknown action" for anything it doesn't recognise,
 * so we intercept before delegating.
 *
 * Credentials never enter the LLM context. The prompt tells the model
 * to emit `fill_username` / `fill_password`; the executor here reads
 * the values from the `credentials` param and types them with
 * per-character jitter. The only string that ever flows through the
 * model is the short-lived 2FA code, and only after the user hands it
 * back through the submit_verification_code tool.
 *
 * The agent halts early (via this.stopped) and records a `pendingStatus`
 * when:
 *   - action === 'emit_pending_2fa'
 *   - action === 'emit_pending_device_approval'
 *   - action === 'escalate_to_human'
 *   - three consecutive turns show no scene transition (stuck)
 *   - probeInstagramLogin reports logged_in: true (success)
 *
 * The plugin-side `login` tool reads pendingStatus after run() returns
 * and routes to the appropriate chat-side followup.
 */

import { Page } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GhostMouse } from './GhostMouse.js';
import { HumanScroll } from './HumanScroll.js';
import { ScreenshotCollector } from './ScreenshotCollector.js';
import {
    BaseVisionAgent,
    type BaseAgentConfig,
    type VisionAction,
} from './BaseVisionAgent.js';
import { ModelConfig } from '../../shared/modelConfig.js';
import { probeInstagramLogin } from '../../plugin/cookie-probe.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const loginInstructions = readFileSync(
    join(__dirname, '../prompts/login-instructions.md'),
    'utf8'
);

export type LoginPendingStatus =
    | 'success'
    | 'pending_2fa'
    | 'pending_device_approval'
    | 'escalate_to_human';

export interface LoginCredentials {
    username: string;
    password: string;
}

export interface LoginAgentConfig extends BaseAgentConfig {
    credentials: LoginCredentials;
    browserProfileDir: string;
    /** Set by submit_verification_code when resuming a pending_2fa flow. */
    verificationCode?: string;
}

/** Extra action names the login flow adds on top of VisionAction. */
type LoginActionName =
    | 'fill_username'
    | 'fill_password'
    | 'emit_pending_2fa'
    | 'emit_pending_device_approval'
    | 'escalate_to_human';

function isLoginAction(a: string): a is LoginActionName {
    return (
        a === 'fill_username' ||
        a === 'fill_password' ||
        a === 'emit_pending_2fa' ||
        a === 'emit_pending_device_approval' ||
        a === 'escalate_to_human'
    );
}

export class LoginAgent extends BaseVisionAgent {
    public pendingStatus: LoginPendingStatus | null = null;
    public pendingDescription: string | null = null;

    private credentials: LoginCredentials;
    private browserProfileDir: string;
    private verificationCode: string | undefined;

    // Stuck detection — same (url, screenshot hash) three turns in a row → escalate.
    private lastUrl: string = '';
    private lastSceneSignature: string = '';
    private stuckCount: number = 0;

    constructor(
        page: Page,
        ghost: GhostMouse,
        scroll: HumanScroll,
        collector: ScreenshotCollector,
        config: LoginAgentConfig
    ) {
        super(page, ghost, scroll, collector, config);
        this.credentials = config.credentials;
        this.browserProfileDir = config.browserProfileDir;
        this.verificationCode = config.verificationCode;
    }

    protected getInstructionPrompt(): string {
        return loginInstructions;
    }

    protected getModel(): string {
        return ModelConfig.navigation;
    }

    protected getMaxTokens(): number {
        return 1024;
    }

    protected getReferenceImageFolder(): string | null {
        // No reference images shipped for login — the prompt's scene list
        // is the structural guide.
        return null;
    }

    protected getAgentName(): string {
        return 'LoginAgent';
    }

    protected shouldLabelElements(): boolean {
        return true;
    }

    /**
     * Override the per-turn user prompt so the 2FA code (if the host
     * supplied one via submit_verification_code) reaches the model.
     * Everything else (username, password) is NEVER passed through here.
     */
    protected buildUserPrompt(remainingMs: number): string {
        let prompt = super.buildUserPrompt(remainingMs);
        if (this.verificationCode) {
            prompt += `\n\nVERIFICATION_CODE: ${this.verificationCode}\nThe user has supplied this code. Type it into the focused 6-digit input and click Confirm/Next.`;
        }
        return prompt;
    }

    /**
     * Intercept login-specific actions before falling through to the
     * base dispatcher. The base class's executeAction returns
     * "unknown action: …" for anything it doesn't recognise, so order
     * matters here.
     */
    protected async executeAction(decision: VisionAction): Promise<string> {
        const name = decision.action as string;

        if (isLoginAction(name)) {
            return this.executeLoginAction(name, decision);
        }

        const result = await super.executeAction(decision);
        await this.postActionChecks(decision);
        return result;
    }

    private async executeLoginAction(
        name: LoginActionName,
        decision: VisionAction
    ): Promise<string> {
        switch (name) {
            case 'fill_username':
                return this.typeCredential('username', this.credentials.username);

            case 'fill_password':
                return this.typeCredential('password', this.credentials.password);

            case 'emit_pending_2fa':
                this.pendingStatus = 'pending_2fa';
                this.pendingDescription = decision.thinking || 'Instagram 2FA screen reached';
                this.stopped = true;
                this.collector.appendLog(`🔐 Pending 2FA: ${this.pendingDescription}`);
                return 'paused — pending 2FA code from user';

            case 'emit_pending_device_approval':
                this.pendingStatus = 'pending_device_approval';
                this.pendingDescription =
                    decision.thinking ||
                    'Instagram sent a login-approval notification to another device';
                this.stopped = true;
                this.collector.appendLog(
                    `🔐 Pending device approval: ${this.pendingDescription}`
                );
                return 'paused — waiting for user to approve on their other device';

            case 'escalate_to_human':
                this.pendingStatus = 'escalate_to_human';
                this.pendingDescription = decision.thinking || 'Agent escalated to human';
                this.stopped = true;
                this.collector.appendLog(
                    `🆘 Escalate to human: ${this.pendingDescription}`
                );
                return 'escalated — host will fall back to headful login window';
        }
    }

    private async typeCredential(
        field: 'username' | 'password',
        value: string
    ): Promise<string> {
        if (!value) {
            this.pendingStatus = 'escalate_to_human';
            this.pendingDescription = `No ${field} configured in session.runConfig`;
            this.stopped = true;
            return `BLOCKED: no ${field} configured`;
        }
        // Short randomised pause before typing — humans don't type the
        // instant a field gains focus.
        await this.delay(400 + Math.floor(Math.random() * 500));

        // Per-character typing with 80–220ms jitter, via Playwright's
        // keyboard.type(delay). We pass the value directly to the browser
        // keyboard event — it never appears in any LLM message.
        for (const ch of value) {
            if (this.stopped) break;
            const per = 80 + Math.floor(Math.random() * 140);
            await this.page.keyboard.type(ch, { delay: per });
        }
        this.collector.appendLog(
            `⌨️ filled ${field} (${value.length} chars, per-char 80–220ms)`
        );
        return `filled ${field} (${value.length} chars)`;
    }

    /**
     * After every non-login action, check:
     *   1. Did login complete? (probeInstagramLogin)
     *   2. Are we stuck? (same URL + same element signature 3 turns in a row)
     */
    private async postActionChecks(decision: VisionAction): Promise<void> {
        // 1. Login-success probe. Valid sessionid cookie + URL looks like
        // the home feed or post-login interstitial → success. We still
        // let the loop finish any Save-info / notifications prompts in-page;
        // only flip to success when the prompt emits `done`.
        try {
            const probe = probeInstagramLogin(this.browserProfileDir);
            if (probe.logged_in === true) {
                const url = this.page.url();
                // Persistent-context cookies flush to disk on close, so a
                // live probe on an open page can lag the login event. We
                // only flip to success here on URLs that imply we're past
                // all the interstitials.
                if (/instagram\.com\/?(\?.*)?$/.test(url) || url.includes('/direct/')) {
                    this.pendingStatus = 'success';
                    this.stopped = true;
                    this.collector.appendLog('✅ Login detected (probe + home URL)');
                    return;
                }
            }
        } catch {
            // Probe errors are expected mid-write; silence.
        }

        // 2. Stuck detection. Signature is (url + element-label hash).
        const url = this.page.url();
        const sig = this.computeSceneSignature();
        if (url === this.lastUrl && sig === this.lastSceneSignature) {
            this.stuckCount += 1;
            if (this.stuckCount >= 3) {
                this.pendingStatus = 'escalate_to_human';
                this.pendingDescription =
                    `Stuck: 3 consecutive turns with no scene change (url=${url}). Last action: ${decision.action}.`;
                this.stopped = true;
                this.collector.appendLog(`🆘 Stuck detected — ${this.pendingDescription}`);
            }
        } else {
            this.stuckCount = 0;
            this.lastUrl = url;
            this.lastSceneSignature = sig;
        }
    }

    private computeSceneSignature(): string {
        const tags: string[] = [];
        for (const [, el] of this.currentElements) {
            tags.push(`${el.tag}|${(el.ariaLabel || el.text || '').slice(0, 30)}`);
        }
        return tags.sort().join(';');
    }

    /**
     * Default happy-path: if the base loop exits via `done` action, treat
     * it as success unless a pending state was already recorded. Called
     * by the plugin-side login tool after run() returns.
     */
    finaliseStatus(): LoginPendingStatus {
        if (this.pendingStatus) return this.pendingStatus;
        // run() ended without a pending signal → assume the LLM said done
        // after observing home feed. The plugin side will re-verify via
        // probeInstagramLogin before reporting success to the user.
        return 'success';
    }
}

/**
 * Helper: build the per-run log dir under session.scratchDir. Mirrors
 * the existing agents' `kowalski-runs/run_<ts>/` convention but uses a
 * `login_<ts>` prefix so login traces are easy to find. Returned path
 * is created on disk.
 */
export function makeLoginRunDir(scratchDir: string): string {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const ts = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(
        now.getHours()
    )}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
    const dir = path.join(scratchDir, 'kowalski-runs', `login_${ts}`);
    fs.mkdirSync(path.join(dir, 'raw'), { recursive: true });
    return dir;
}
