import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const MISSING_BROWSER_MESSAGE =
    'Bundled Chromium is missing. Run `npm run setup:browser` in the plugin directory.';

type ChromiumBrowserName = 'chromium' | 'chromium-headless-shell';
type SupportedPlatformKey = 'darwin-x64' | 'darwin-arm64' | 'linux-x64' | 'win32-x64';

type BrowserJsonEntry = {
    name: string;
    revision: string;
    browserVersion?: string;
};

type BrowsersJson = {
    browsers?: BrowserJsonEntry[];
};

export type BundledBrowserCandidate = {
    browserName: ChromiumBrowserName;
    revision: string;
    browserVersion: string | null;
    localBrowsersDir: string;
    browserInstallDir: string;
    executablePath: string;
    platformKey: SupportedPlatformKey;
};

export type BundledBrowserResolution = BundledBrowserCandidate & {
    exists: true;
    isExecutable: boolean;
};

const EXECUTABLE_PATHS: Record<ChromiumBrowserName, Record<SupportedPlatformKey, string[]>> = {
    chromium: {
        'darwin-x64': [
            'chrome-mac-x64',
            'Google Chrome for Testing.app',
            'Contents',
            'MacOS',
            'Google Chrome for Testing',
        ],
        'darwin-arm64': [
            'chrome-mac-arm64',
            'Google Chrome for Testing.app',
            'Contents',
            'MacOS',
            'Google Chrome for Testing',
        ],
        'linux-x64': ['chrome-linux64', 'chrome'],
        'win32-x64': ['chrome-win64', 'chrome.exe'],
    },
    'chromium-headless-shell': {
        'darwin-x64': ['chrome-headless-shell-mac-x64', 'chrome-headless-shell'],
        'darwin-arm64': ['chrome-headless-shell-mac-arm64', 'chrome-headless-shell'],
        'linux-x64': ['chrome-headless-shell-linux64', 'chrome-headless-shell'],
        'win32-x64': ['chrome-headless-shell-win64', 'chrome-headless-shell.exe'],
    },
};

const requireFromHere = createRequire(import.meta.url);

function browserDirectoryName(name: ChromiumBrowserName): string {
    return name.replaceAll('-', '_') as string;
}

function readBrowsersJson(browsersJsonPath: string): BrowsersJson {
    return JSON.parse(fs.readFileSync(browsersJsonPath, 'utf-8')) as BrowsersJson;
}

function getBrowsersJsonPath(): string {
    return path.join(path.dirname(requireFromHere.resolve('playwright-core/package.json')), 'browsers.json');
}

function requireBrowserEntry(browsersJson: BrowsersJson, name: ChromiumBrowserName): BrowserJsonEntry {
    const entry = browsersJson.browsers?.find((browser) => browser.name === name);
    if (!entry?.revision) {
        throw new Error(`playwright-core/browsers.json is missing the ${name} revision.`);
    }
    return entry;
}

export function getBundledBrowserPlatformKey(
    platform: NodeJS.Platform = process.platform,
    arch: NodeJS.Architecture = process.arch
): SupportedPlatformKey {
    if (platform === 'darwin' && (arch === 'x64' || arch === 'arm64')) {
        return `darwin-${arch}`;
    }
    if (platform === 'linux' && arch === 'x64') {
        return 'linux-x64';
    }
    if (platform === 'win32' && arch === 'x64') {
        return 'win32-x64';
    }

    throw new Error(`Unsupported bundled Chromium platform: ${platform}-${arch}`);
}

export function getPlaywrightChromiumBrowserInfo(): {
    browsersJsonPath: string;
    playwrightCoreDir: string;
    localBrowsersDir: string;
    chromium: BrowserJsonEntry;
    chromiumHeadlessShell: BrowserJsonEntry;
} {
    const browsersJsonPath = getBrowsersJsonPath();
    const playwrightCoreDir = path.dirname(browsersJsonPath);
    const browsersJson = readBrowsersJson(browsersJsonPath);

    return {
        browsersJsonPath,
        playwrightCoreDir,
        localBrowsersDir: path.join(playwrightCoreDir, '.local-browsers'),
        chromium: requireBrowserEntry(browsersJson, 'chromium'),
        chromiumHeadlessShell: requireBrowserEntry(browsersJson, 'chromium-headless-shell'),
    };
}

export function getBundledBrowserExecutableCandidates(options: {
    platform?: NodeJS.Platform;
    arch?: NodeJS.Architecture;
    localBrowsersDir?: string;
    browsersJson?: BrowsersJson;
    browsersJsonPath?: string;
} = {}): BundledBrowserCandidate[] {
    const platformKey = getBundledBrowserPlatformKey(options.platform, options.arch);
    const browsersJsonPath = options.browsersJsonPath ?? getBrowsersJsonPath();
    const playwrightCoreDir = path.dirname(browsersJsonPath);
    const localBrowsersDir =
        options.localBrowsersDir ?? path.join(playwrightCoreDir, '.local-browsers');
    const browsersJson = options.browsersJson ?? readBrowsersJson(browsersJsonPath);
    const browserNames: ChromiumBrowserName[] = ['chromium-headless-shell', 'chromium'];

    return browserNames.map((browserName) => {
        const entry = requireBrowserEntry(browsersJson, browserName);
        const browserInstallDir = path.join(
            localBrowsersDir,
            `${browserDirectoryName(browserName)}-${entry.revision}`
        );

        return {
            browserName,
            revision: entry.revision,
            browserVersion: entry.browserVersion ?? null,
            localBrowsersDir,
            browserInstallDir,
            executablePath: path.join(browserInstallDir, ...EXECUTABLE_PATHS[browserName][platformKey]),
            platformKey,
        };
    });
}

export function resolveBundledBrowserExecutable(): string {
    const match = resolveBundledBrowser();
    return match.executablePath;
}

export function resolveBundledBrowser(): BundledBrowserResolution {
    const candidates = getBundledBrowserExecutableCandidates();
    const match = candidates.find((candidate) => fs.existsSync(candidate.executablePath));

    if (!match) {
        const checkedPaths = candidates
            .map((candidate) => `  - ${candidate.executablePath}`)
            .join('\n');
        throw new Error(`${MISSING_BROWSER_MESSAGE}\nChecked:\n${checkedPaths}`);
    }

    return {
        ...match,
        exists: true,
        isExecutable: isExecutable(match.executablePath),
    };
}

export function isExecutable(executablePath: string): boolean {
    if (process.platform === 'win32') return true;

    try {
        fs.accessSync(executablePath, fs.constants.X_OK);
        return true;
    } catch {
        return false;
    }
}

export { MISSING_BROWSER_MESSAGE };
