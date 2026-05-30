import {
    getPlaywrightChromiumBrowserInfo,
    resolveBundledBrowserExecutable,
} from './BundledBrowserResolver.js';

/**
 * Production-safe helper for detecting Chromium version and generating User-Agent.
 * Uses playwright-core/browsers.json instead of the user's Playwright cache so
 * UA generation tracks the plugin-bundled Chromium.
 */
export class ChromiumVersionHelper {
    private static cachedVersion: string | null = null;
    private static cachedRevision: string | null = null;
    private static cachedUserAgent: string | null = null;

    /**
     * Gets Chromium version from playwright-core/browsers.json.
     * The fallback is only for UA generation/logging, never for launch path.
     */
    static getChromiumVersion(): string {
        if (this.cachedVersion) return this.cachedVersion;

        this.cachedVersion = this.tryReadBrowsersJson();
        if (this.cachedVersion) return this.cachedVersion;

        console.warn('⚠️ ChromiumVersionHelper: Using hardcoded fallback version');
        this.cachedVersion = '143.0.0.0';
        return this.cachedVersion;
    }

    /**
     * Try reading version from playwright-core's browsers.json.
     */
    private static tryReadBrowsersJson(): string | null {
        try {
            const { chromiumHeadlessShell, chromium } = getPlaywrightChromiumBrowserInfo();
            const version = chromiumHeadlessShell.browserVersion ?? chromium.browserVersion;
            if (version) {
                console.log(`🔍 ChromiumVersionHelper: Detected v${version} from browsers.json`);
                return version;
            }
        } catch (error) {
            console.warn('⚠️ ChromiumVersionHelper: browsers.json not accessible:', error);
        }
        return null;
    }

    /**
     * Gets the latest installed Chromium revision number
     * from playwright-core/browsers.json.
     */
    static getLatestRevision(): string {
        if (this.cachedRevision) return this.cachedRevision;

        try {
            const { chromiumHeadlessShell, chromium } = getPlaywrightChromiumBrowserInfo();
            this.cachedRevision = chromiumHeadlessShell.revision ?? chromium.revision;
            console.log(`🔍 ChromiumVersionHelper: Latest revision is ${this.cachedRevision}`);
        } catch (error) {
            console.warn('⚠️ ChromiumVersionHelper: Failed to detect revision:', error);
            this.cachedRevision = 'unknown';
        }

        return this.cachedRevision;
    }

    /**
     * Generates a platform-appropriate User-Agent string
     * Automatically uses the detected Chromium version
     */
    static generateUserAgent(): string {
        if (this.cachedUserAgent) return this.cachedUserAgent;

        const version = this.getChromiumVersion();
        const majorVersion = version.split('.')[0];

        if (process.platform === 'darwin') {
            this.cachedUserAgent = `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
        } else if (process.platform === 'win32') {
            this.cachedUserAgent = `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
        } else {
            this.cachedUserAgent = `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${majorVersion}.0.0.0 Safari/537.36`;
        }

        console.log(`🔍 ChromiumVersionHelper: Generated User-Agent with Chrome/${majorVersion}`);
        return this.cachedUserAgent;
    }

    /**
     * Constructs the path to the bundled Kowalski browser executable.
     */
    static getCustomExecutablePath(): string {
        return resolveBundledBrowserExecutable();
    }

}
