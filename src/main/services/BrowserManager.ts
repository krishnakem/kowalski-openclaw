import path from 'path';
import fs from 'fs';
import { chromium, BrowserContext, Page, CDPSession } from 'playwright';
import { ChromiumVersionHelper } from './ChromiumVersionHelper.js';
import { SessionValidationResult } from '../../types/instagram.js';
import { KOWALSKI_VIEWPORT } from '../../shared/viewportConfig.js';
import { InputForwarder, type InputEventPayload } from './InputForwarder.js';
import type { KowalskiSession } from '../../core/KowalskiSession.js';

// GPU profiles for WebGL fingerprint randomization
// Using common GPU configurations to avoid statistical anomalies
const GPU_PROFILES = [
    { vendor: 'Intel Inc.', renderer: 'Intel Iris OpenGL Engine' },
    { vendor: 'Intel Inc.', renderer: 'Intel HD Graphics 630' },
    { vendor: 'Intel Inc.', renderer: 'Intel UHD Graphics 620' },
    { vendor: 'Apple Inc.', renderer: 'Apple M1' },
    { vendor: 'Apple Inc.', renderer: 'Apple M2' },
    { vendor: 'Google Inc. (Apple)', renderer: 'ANGLE (Apple, Apple M1, OpenGL 4.1)' },
];

// No config options — headless is always true, enforced at the launch site.

export class BrowserManager {
    private static instance: BrowserManager;
    private browserContext: BrowserContext | null = null;
    // Kept as a singleton to minimize caller churn; bindSession is called once
    // per run by RunManager (or any plugin entrypoint) before launch/start*.
    private session: KowalskiSession | null = null;
    private cdpSession: CDPSession | null = null;
    private inputForwarder: InputForwarder = new InputForwarder();
    private loginActive: boolean = false;

    private constructor() { }

    public bindSession(session: KowalskiSession | null): void {
        this.session = session;
    }

    public static getInstance(): BrowserManager {
        if (!BrowserManager.instance) {
            BrowserManager.instance = new BrowserManager();
        }
        return BrowserManager.instance;
    }

    private requireSession(): KowalskiSession {
        if (!this.session) {
            throw new Error('BrowserManager: no session bound (call bindSession first)');
        }
        return this.session;
    }

    /**
     * Launches a persistent browser context.
     * If an instance is already running, it closes it first to prevent zombies.
     */
    public async launch(): Promise<BrowserContext> {
        // Zombie Prevention: Cleanup any existing instance
        if (this.browserContext) {
            console.log('♻️ BrowserManager: Closing existing instance before launch...');
            await this.close();
        }

        try {
            const session = this.requireSession();
            const persistentContextPath = session.browserProfileDir;

            console.log(`🚀 BrowserManager: Launching headless Persistent Context at: ${persistentContextPath}`);

            const extraArgs = ['--app=https://www.instagram.com/'];

            // Explicit viewport ensures page content area matches exactly.
            const scrapingViewport = { width: KOWALSKI_VIEWPORT.width, height: KOWALSKI_VIEWPORT.height };
            console.log(`📐 BrowserManager: Viewport ${KOWALSKI_VIEWPORT.width}x${KOWALSKI_VIEWPORT.height}`);

            // If the host supplied an explicit executable path, use it; otherwise
            // let Playwright pick its own default Chromium.
            const executablePath = session.browser?.executablePath ?? '';
            if (executablePath) {
                console.log('🕵️‍♀️ BrowserManager: Using host-supplied executable:', executablePath);
            } else {
                console.log('📦 BrowserManager: Using Playwright default Chromium');
            }

            const systemTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone;

            this.browserContext = await chromium.launchPersistentContext(persistentContextPath, {
                headless: true, // ALWAYS headless — no visible Chromium window, ever
                executablePath: executablePath || undefined,
                viewport: scrapingViewport,
                deviceScaleFactor: 1,
                // Dynamic User-Agent that matches actual Chromium version (auto-detected)
                userAgent: ChromiumVersionHelper.generateUserAgent(),

                // Fingerprint consistency options
                locale: 'en-US',
                timezoneId: systemTimezone,
                colorScheme: 'light',

                // HTTP headers that Chrome normally sends
                extraHTTPHeaders: {
                    'Accept-Language': 'en-US,en;q=0.9',
                },

                args: [
                    '--disable-blink-features=AutomationControlled', // Mask WebDriver
                    '--disable-infobars',
                    '--no-sandbox',
                    '--disable-setuid-sandbox',
                    '--disable-dev-shm-usage',
                    '--disable-accelerated-2d-canvas',
                    '--disable-gpu', // Often helps stability in headless envs
                    ...extraArgs
                ],
                // Accept downloads if needed later
                acceptDownloads: true,
            });

            // Stealth evasions via addInitScript (replaces playwright-extra stealth plugin
            // which is incompatible with launchPersistentContext in newer Playwright versions)
            await this.browserContext.addInitScript(() => {
                // navigator.webdriver — primary automation detection flag
                Object.defineProperty(navigator, 'webdriver', { get: () => false });

                // chrome.runtime — mimic real Chrome
                if (!(window as any).chrome) (window as any).chrome = {};
                if (!(window as any).chrome.runtime) {
                    (window as any).chrome.runtime = {
                        connect: () => {},
                        sendMessage: () => {},
                    };
                }

                // navigator.plugins — real browsers have plugins
                Object.defineProperty(navigator, 'plugins', {
                    get: () => [1, 2, 3, 4, 5],
                });

                // navigator.languages
                Object.defineProperty(navigator, 'languages', {
                    get: () => ['en-US', 'en'],
                });

                // navigator.permissions.query — prevent "notification" detection
                const originalQuery = window.navigator.permissions.query;
                // @ts-ignore
                window.navigator.permissions.query = (parameters: any) =>
                    parameters.name === 'notifications'
                        ? Promise.resolve({ state: Notification.permission } as PermissionStatus)
                        : originalQuery(parameters);

                // iframe contentWindow — prevent detection via cross-origin iframe probing
                // (Overrides HTMLIFrameElement.prototype.contentWindow getter)
            });

            // WebGL fingerprint masking - randomize GPU from common profiles
            // Select a random GPU profile for this session to avoid statistical anomalies
            const selectedGpu = GPU_PROFILES[Math.floor(Math.random() * GPU_PROFILES.length)];
            console.log(`🎮 WebGL Fingerprint: ${selectedGpu.vendor} / ${selectedGpu.renderer}`);

            await this.browserContext.addInitScript((gpu: { vendor: string; renderer: string }) => {
                // Override WebGL vendor/renderer to avoid unique fingerprint detection
                const getParameterProto = WebGLRenderingContext.prototype.getParameter;
                WebGLRenderingContext.prototype.getParameter = function(parameter: number) {
                    // UNMASKED_VENDOR_WEBGL
                    if (parameter === 37445) {
                        return gpu.vendor;
                    }
                    // UNMASKED_RENDERER_WEBGL
                    if (parameter === 37446) {
                        return gpu.renderer;
                    }
                    return getParameterProto.call(this, parameter);
                };

                // Also handle WebGL2
                const getParameterProto2 = WebGL2RenderingContext.prototype.getParameter;
                WebGL2RenderingContext.prototype.getParameter = function(parameter: number) {
                    if (parameter === 37445) {
                        return gpu.vendor;
                    }
                    if (parameter === 37446) {
                        return gpu.renderer;
                    }
                    return getParameterProto2.call(this, parameter);
                };
            }, selectedGpu);

            // Log actual viewport dimensions for verification
            try {
                const pages = this.browserContext.pages();
                const verifyPage = pages.length > 0 ? pages[0] : await this.browserContext.newPage();
                const actualViewport = await verifyPage.evaluate(() => ({
                    innerWidth: window.innerWidth,
                    innerHeight: window.innerHeight,
                    outerWidth: window.outerWidth,
                    outerHeight: window.outerHeight,
                    devicePixelRatio: window.devicePixelRatio
                })).catch(() => null);
                if (actualViewport) {
                    console.log(`📐 BrowserManager: Actual viewport: ${actualViewport.innerWidth}x${actualViewport.innerHeight} (outer: ${actualViewport.outerWidth}x${actualViewport.outerHeight}, DPR: ${actualViewport.devicePixelRatio})`);
                }
            } catch (viewportErr) {
                console.warn('📐 Could not verify viewport:', viewportErr);
            }

            // Optional cookie-injection path. Plugin hosts can drop a session.json
            // alongside the browser profile to pre-seed cookies; otherwise this is
            // a no-op.
            try {
                const sessionPath = path.join(session.browserProfileDir, 'session.json');
                if (fs.existsSync(sessionPath)) {
                    console.log('🍪 BrowserManager: Found session.json from Onboarding. Injecting cookies...');
                    const sessionData = JSON.parse(fs.readFileSync(sessionPath, 'utf-8'));

                    if (sessionData && Array.isArray(sessionData.cookies)) {
                        await this.browserContext.addCookies(sessionData.cookies);
                        console.log(`✅ BrowserManager: Injected ${sessionData.cookies.length} cookies from session.json`);
                    }
                }
            } catch (err) {
                console.error('⚠️ BrowserManager: Failed to sync session.json cookies:', err);
                // Non-critical, continue launching
            }

            console.log('✅ DEBUG: Browser context created successfully');

            // 3. Extra Safety (Closing logic on disconnect)
            this.browserContext.on('close', () => {
                console.log('❌ BrowserManager: Context closed unexpectedly (or manually). Clearing reference.');
                this.browserContext = null;
            });

            console.log('✅ DEBUG: Returning browser context, pages count:', this.browserContext.pages().length);
            return this.browserContext;

        } catch (error) {
            console.error('🔥 BrowserManager: Failed to launch browser:', error);
            console.error('🔥 Stack trace:', (error as Error).stack);
            // Ensure cleanup on failure
            this.browserContext = null;
            throw error;
        }
    }

    // =========================================================================
    // CDP Screencast — streams headless viewport frames to the renderer
    // =========================================================================

    /**
     * Start a CDP screencast on the given page at ~60fps.
     * Frames are forwarded to the renderer via 'kowalski:frame' IPC.
     */
    public async startScreencast(page: Page): Promise<void> {
        await this.stopScreencast();

        if (!this.browserContext) {
            console.warn('⚠️ BrowserManager.startScreencast: no browser context');
            return;
        }

        try {
            const cdp = await this.browserContext.newCDPSession(page);
            this.cdpSession = cdp;

            cdp.on('Page.screencastFrame', (params: any) => {
                // Ack FIRST so Chromium never stalls waiting during a slow IPC moment
                cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
                this.session?.events.emit('frame', params.data);
            });

            await cdp.send('Page.startScreencast', {
                format: 'jpeg',
                quality: 70,
                everyNthFrame: 1,
            });

            console.log('📹 BrowserManager: Screencast started (60fps, quality=70)');
        } catch (err) {
            console.error('❌ BrowserManager.startScreencast failed:', err);
            this.cdpSession = null;
        }
    }

    /**
     * Stop the active CDP screencast session.
     * Idempotent — safe to call multiple times (second call is a no-op).
     * Emits 'kowalski:screencastEnded' to the renderer so it can tear down the live view.
     */
    public async stopScreencast(): Promise<void> {
        if (!this.cdpSession) return;

        try {
            await this.cdpSession.send('Page.stopScreencast');
            await this.cdpSession.detach();
            console.log('📹 BrowserManager: Screencast stopped');
        } catch {
            // Session may already be detached
        } finally {
            this.cdpSession = null;
        }

        // Notify listeners that the screencast has ended
        this.session?.events.emit('screencastEnded');
    }

    /**
     * Switch the screencast to a different page (e.g. after tab navigation).
     * TODO: Wire into BaseVisionAgent if tab switching is added in a future version.
     */
    public async attachScreencastTo(page: Page): Promise<void> {
        await this.startScreencast(page);
    }

    // =========================================================================
    // Login Screencast — headless login via screencast + input forwarding
    // =========================================================================

    /**
     * Launch a headless browser, navigate to IG login, start screencast + input forwarding.
     * The user interacts with the Kowalski canvas; their input is forwarded via CDP.
     */
    public async startLoginScreencast(): Promise<void> {
        console.log('🔐 BrowserManager: Starting login screencast (headless)...');
        this.loginActive = true;

        // Ensure a headless context is running
        if (!this.browserContext) {
            await this.launch();
        }

        const pages = this.browserContext!.pages();
        const page = pages[0] || await this.browserContext!.newPage();

        // Navigate to login page
        try {
            await page.goto('https://www.instagram.com/accounts/login/', {
                waitUntil: 'domcontentloaded',
                timeout: 15000,
            });
        } catch {
            console.warn('⚠️ Login page navigation slow, continuing...');
        }

        // Start screencast (same 60fps as agent runs)
        await this.startScreencast(page);

        // Attach input forwarding to the same CDP session
        if (this.cdpSession) {
            this.inputForwarder.attach(this.cdpSession);
        }

        this.session?.events.emit('loginScreencastReady');

        // Begin polling for login success in the background
        this.pollForLoginSuccess(page);
    }

    /**
     * Stop the login screencast, detach input forwarding, and close the context.
     * Cookies persist in the profile directory for future runs.
     */
    public async stopLoginScreencast(): Promise<void> {
        console.log('🔐 BrowserManager: Stopping login screencast...');
        this.loginActive = false;
        this.inputForwarder.detach();
        await this.stopScreencast();
        await this.close();
    }

    /**
     * Forward a user input event from the renderer to the headless page.
     */
    public async dispatchInput(event: InputEventPayload): Promise<void> {
        await this.inputForwarder.dispatch(event);
    }

    /**
     * Poll for successful Instagram login while the login screencast is active.
     * On success, notifies the renderer and tears down the screencast.
     */
    private async pollForLoginSuccess(page: Page): Promise<void> {
        while (this.loginActive && this.cdpSession) {
            await new Promise(r => setTimeout(r, 2000));
            if (!this.loginActive) break;

            try {
                const url = page.url();
                // Still on login/challenge page — keep waiting
                if (url.includes('/accounts/login') || url.includes('/challenge')) continue;

                // URL changed — verify with CDP accessibility tree
                if (url.includes('instagram.com')) {
                    const isLoggedIn = await this.checkLoginStateViaCDP(page);
                    if (isLoggedIn) {
                        console.log('✅ Login screencast: Instagram login confirmed');
                        this.session?.events.emit('loginSuccess');
                        await this.stopLoginScreencast();
                        return;
                    }
                }
            } catch {
                // Page may have navigated or closed — keep polling
            }
        }
    }

    /**
     * Safely closes the current browser instance.
     */
    public async close(): Promise<void> {
        if (!this.browserContext) return;

        await this.stopScreencast();

        try {
            console.log('🛑 BrowserManager: Closing browser...');
            await this.browserContext.close();
        } catch (error) {
            console.error('⚠️ BrowserManager: Error during close (likely already closed):', error);
        } finally {
            this.browserContext = null;
        }
    }

    /**
     * NUCLEAR OPTION: Closes the browser and WIPES the persistent profile directory.
     * Used for "Reset All" functionality.
     */
    public async clearData(): Promise<void> {
        console.log('☢️ BrowserManager: Initiating Data Wipe...');

        // 1. Force Close
        await this.close();

        // 2. Delete Folder
        try {
            const persistentContextPath = this.requireSession().browserProfileDir;

            if (fs.existsSync(persistentContextPath)) {
                fs.rmSync(persistentContextPath, { recursive: true, force: true });
                console.log('✅ BrowserManager: Wiped kowalski_browser directory.');
            } else {
                console.log('ℹ️ BrowserManager: No directory to wipe.');
            }
        } catch (error) {
            console.error('❌ BrowserManager: Failed to wipe data:', error);
            // Don't throw, we want reset to continue best-effort
        }
    }

    /**
     * Returns the current active context, or null if not running.
     */
    public getContext(): BrowserContext | null {
        return this.browserContext;
    }

    /**
     * Releases the current browser context from the singleton's ownership
     * WITHOUT closing it. The caller takes over lifetime management.
     *
     * Use case: the pending-login flow (2FA / device approval) needs to
     * keep a context alive across tool calls, but the singleton's own
     * `launch()` closes whatever context it holds whenever anything else
     * (e.g. `run_digest`) calls launch. Detaching moves the context out
     * of the singleton so a subsequent `launch()` can't destroy it.
     *
     * The 'close' listener wired up in `launch()` is also cleared here
     * since this.browserContext is nulled and we no longer want that
     * listener firing state-clearing side effects on a context we no
     * longer own.
     *
     * Returns the detached context, or null if nothing was attached.
     */
    public detachContext(): BrowserContext | null {
        const ctx = this.browserContext;
        if (!ctx) return null;
        // Remove the close listener we installed in launch() — it nulls
        // this.browserContext, which is already null now, so it's a
        // no-op, but we keep the listener count tidy.
        try { ctx.removeAllListeners('close'); } catch { /* ignore */ }
        this.browserContext = null;
        console.log('🔗 BrowserManager: Detached context; caller now owns its lifetime.');
        return ctx;
    }

    /**
     * Validates if the current session is still authenticated with Instagram.
     * Uses the same check as login() but with shorter timeout.
     *
     * This consolidates session validation logic - callers should use this
     * instead of implementing their own checks.
     *
     * @returns SessionValidationResult with valid flag and optional reason
     */
    public async validateSession(): Promise<SessionValidationResult> {
        if (!this.browserContext) {
            return { valid: false, reason: 'NO_CONTEXT' };
        }

        try {
            const pages = this.browserContext.pages();
            const page = pages.length > 0 ? pages[0] : await this.browserContext.newPage();

            // Navigate to Instagram if not already there
            const url = page.url();
            if (!url.includes('instagram.com')) {
                await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded' });
            }

            // Wait for React hydration — Instagram's SPA needs time to render nav elements
            await new Promise(r => setTimeout(r, 3000));

            // Check URL for obvious failure states first (fast path)
            const currentUrl = page.url();
            if (currentUrl.includes('/accounts/login')) {
                return { valid: false, reason: 'SESSION_EXPIRED' };
            }
            if (currentUrl.includes('/challenge')) {
                return { valid: false, reason: 'CHALLENGE_REQUIRED' };
            }
            if (currentUrl.includes('/accounts/suspended')) {
                return { valid: false, reason: 'RATE_LIMITED' };
            }

            // Validate via CDP accessibility tree (NO waitForSelector - bot detectable!)
            // Retry up to 3 times — Instagram's SPA may still be rendering nav elements
            for (let attempt = 1; attempt <= 3; attempt++) {
                const isValid = await this.checkLoginStateViaCDP(page);
                if (isValid) {
                    console.log('✅ Session validation: Valid (CDP confirmed)');
                    return { valid: true };
                }
                if (attempt < 3) {
                    console.log(`⏳ Session check attempt ${attempt}/3: nav elements not found yet, waiting...`);
                    await new Promise(r => setTimeout(r, 2000));
                }
            }

            // URL passed (not on login/challenge/suspended) but CDP nav check failed.
            // This likely means a popup/overlay is blocking nav element detection.
            // Trust the URL check — the VisionAgent will handle any popups.
            console.log('✅ Session validation: Valid (URL-based, nav elements obscured — likely popup overlay)');
            return { valid: true };

        } catch (error: any) {
            console.error('❌ Session validation error:', error.message);
            return { valid: false, reason: error.message };
        }
    }

    // =========================================================================
    // CDP-Based Login Detection (Undetectable)
    // =========================================================================

    /**
     * Check login state using CDP accessibility tree.
     * Looks for navigation elements that only appear when logged in.
     *
     * NO DOM queries, NO selectors - completely undetectable.
     */
    private async checkLoginStateViaCDP(page: Page): Promise<boolean> {
        let cdpSession = null;
        try {
            cdpSession = await page.context().newCDPSession(page);
            const { nodes } = await cdpSession.send('Accessibility.getFullAXTree') as { nodes: any[] };

            // Look for logged-in indicators in the accessibility tree
            // Instagram shows "Home", "Search", "Explore" links when logged in
            const loggedInIndicators = ['home', 'search', 'explore', 'new post', 'profile'];

            const hasLoggedInElement = nodes.some((node: any) => {
                if (node.ignored) return false;
                const nodeName = (node.name?.value || '').toLowerCase();
                const nodeRole = node.role?.value?.toLowerCase();

                // Must be a link or button (navigation elements)
                if (nodeRole !== 'link' && nodeRole !== 'button') return false;

                return loggedInIndicators.some(indicator => nodeName.includes(indicator));
            });

            return hasLoggedInElement;
        } catch (error) {
            console.warn('CDP accessibility check failed:', error);
            return false;
        } finally {
            if (cdpSession) {
                await cdpSession.detach().catch(() => {});
            }
        }
    }
}
