import fs from 'fs';
import path from 'path';
import { app } from 'electron';

/**
 * Production-safe helper for detecting Chromium version and generating User-Agent.
 * Uses a 3-tier fallback chain to ensure it works in both development and packaged apps.
 */
export class ChromiumVersionHelper {
    private static cachedVersion: string | null = null;
    private static cachedRevision: string | null = null;
    private static cachedUserAgent: string | null = null;

    /**
     * Gets Chromium version using a production-safe fallback chain:
     * 1. browsers.json via require() (handles asar transparency)
     * 2. Scan Playwright cache directory (external to app bundle)
     * 3. Hardcoded fallback (safety net)
     */
    static getChromiumVersion(): string {
        if (this.cachedVersion) return this.cachedVersion;

        // Method 1: Try browsers.json via require (asar-safe)
        this.cachedVersion = this.tryReadBrowsersJson();
        if (this.cachedVersion) return this.cachedVersion;

        // Method 2: Detect from Playwright cache (production-safe)
        this.cachedVersion = this.tryDetectFromCache();
        if (this.cachedVersion) return this.cachedVersion;

        // Method 3: Hardcoded fallback
        console.warn('⚠️ ChromiumVersionHelper: Using hardcoded fallback version');
        this.cachedVersion = '143.0.0.0';
        return this.cachedVersion;
    }

    /**
     * Try reading version from playwright-core's browsers.json
     * Uses require() which handles asar transparency in production
     */
    private static tryReadBrowsersJson(): string | null {
        try {
            // require() works with asar - no need for fs.readFileSync
            // eslint-disable-next-line @typescript-eslint/no-var-requires
            const browsersJson = require('playwright-core/browsers.json');
            const chromiumEntry = browsersJson.browsers?.find(
                (b: { name: string }) => b.name === 'chromium'
            );
            if (chromiumEntry?.browserVersion) {
                console.log(`🔍 ChromiumVersionHelper: Detected v${chromiumEntry.browserVersion} from browsers.json`);
                return chromiumEntry.browserVersion;
            }
        } catch (error) {
            // Expected to fail in some edge cases - fall through to next method
            console.log('🔍 ChromiumVersionHelper: browsers.json not accessible, trying cache scan...');
        }
        return null;
    }

    /**
     * Scan the Playwright cache directory to detect installed Chromium revision
     * This is production-safe because the cache is on the user's filesystem
     */
    private static tryDetectFromCache(): string | null {
        try {
            const userHome = app.getPath('home');
            const cacheDir = this.getPlaywrightCacheDir(userHome);

            if (!fs.existsSync(cacheDir)) return null;

            // Find all chromium-* directories and get the highest revision
            const revisions = fs.readdirSync(cacheDir)
                .filter(d => d.startsWith('chromium-') && !d.includes('headless'))
                .map(d => parseInt(d.replace('chromium-', ''), 10))
                .filter(n => !isNaN(n))
                .sort((a, b) => b - a); // Descending order

            if (revisions.length > 0) {
                const latestRevision = revisions[0];
                const version = this.revisionToVersion(latestRevision);
                console.log(`🔍 ChromiumVersionHelper: Detected revision ${latestRevision} → Chrome ${version}`);
                return version;
            }
        } catch (error) {
            console.warn('⚠️ ChromiumVersionHelper: Cache scan failed:', error);
        }
        return null;
    }

    /**
     * Maps Playwright revision numbers to approximate Chrome versions
     * Based on Playwright release history
     */
    private static revisionToVersion(revision: number): string {
        // Mapping based on Playwright releases
        // Update this periodically or when issues arise
        const versionMap: [number, string][] = [
            [1255, '145.0.0.0'],
            [1220, '143.0.0.0'],
            [1200, '131.0.0.0'],
            [1140, '128.0.0.0'],
            [1100, '125.0.0.0'],
        ];

        // Find the closest match (revision >= known)
        for (const [knownRevision, version] of versionMap) {
            if (revision >= knownRevision) {
                return version;
            }
        }

        // Default for older revisions
        return '125.0.0.0';
    }

    /**
     * Gets the Playwright cache directory for the current platform.
     * In a packaged app, Chromium is bundled under Contents/Resources/playwright-browsers.
     */
    private static getPlaywrightCacheDir(userHome: string): string {
        if (app.isPackaged) {
            return path.join(process.resourcesPath, 'playwright-browsers');
        }
        if (process.platform === 'darwin') {
            return path.join(userHome, 'Library/Caches/ms-playwright');
        } else if (process.platform === 'win32') {
            return path.join(userHome, 'AppData/Local/ms-playwright');
        } else {
            return path.join(userHome, '.cache/ms-playwright');
        }
    }

    /**
     * Gets the latest installed Chromium revision number
     * Used for constructing the executable path
     */
    static getLatestRevision(): string {
        if (this.cachedRevision) return this.cachedRevision;

        try {
            const userHome = app.getPath('home');
            const cacheDir = this.getPlaywrightCacheDir(userHome);

            if (!fs.existsSync(cacheDir)) {
                this.cachedRevision = '1200'; // Fallback
                return this.cachedRevision;
            }

            const revisions = fs.readdirSync(cacheDir)
                .filter(d => d.startsWith('chromium-') && !d.includes('headless'))
                .map(d => d.replace('chromium-', ''))
                .filter(r => !isNaN(parseInt(r, 10)))
                .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));

            this.cachedRevision = revisions[0] || '1200';
            console.log(`🔍 ChromiumVersionHelper: Latest revision is ${this.cachedRevision}`);
        } catch (error) {
            console.warn('⚠️ ChromiumVersionHelper: Failed to detect revision:', error);
            this.cachedRevision = '1200';
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
     * Constructs the path to the custom Kowalski browser executable
     * Dynamically uses the latest installed revision
     */
    static getCustomExecutablePath(): string {
        const userHome = app.getPath('home');
        const revision = this.getLatestRevision();
        const cacheDir = this.getPlaywrightCacheDir(userHome);

        if (process.platform === 'darwin') {
            return path.join(
                cacheDir,
                `chromium-${revision}/chrome-mac-arm64/Kowalski.app/Contents/MacOS/Google Chrome for Testing`
            );
        } else if (process.platform === 'win32') {
            return path.join(
                cacheDir,
                `chromium-${revision}/chrome-win/Kowalski.exe`
            );
        } else {
            return path.join(
                cacheDir,
                `chromium-${revision}/chrome-linux/Kowalski`
            );
        }
    }

}
