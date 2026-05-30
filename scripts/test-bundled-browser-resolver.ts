import path from 'node:path';

import {
    getBundledBrowserExecutableCandidates,
    getBundledBrowserPlatformKey,
} from '../src/main/services/BundledBrowserResolver.js';

function fail(msg: string): never {
    console.error(`❌ ${msg}`);
    process.exit(1);
}

function assert(cond: unknown, msg: string): asserts cond {
    if (!cond) fail(msg);
}

const fakeBrowsersJson = {
    browsers: [
        {
            name: 'chromium',
            revision: '1234',
            browserVersion: '150.0.0.0',
        },
        {
            name: 'chromium-headless-shell',
            revision: '1234',
            browserVersion: '150.0.0.0',
        },
    ],
};

const localBrowsersDir = path.join('/', 'plugin', 'node_modules', 'playwright-core', '.local-browsers');

const cases = [
    {
        platform: 'darwin' as const,
        arch: 'arm64' as const,
        key: 'darwin-arm64',
        headlessSuffix: path.join(
            'chromium_headless_shell-1234',
            'chrome-headless-shell-mac-arm64',
            'chrome-headless-shell'
        ),
        chromiumSuffix: path.join(
            'chromium-1234',
            'chrome-mac-arm64',
            'Google Chrome for Testing.app',
            'Contents',
            'MacOS',
            'Google Chrome for Testing'
        ),
    },
    {
        platform: 'darwin' as const,
        arch: 'x64' as const,
        key: 'darwin-x64',
        headlessSuffix: path.join(
            'chromium_headless_shell-1234',
            'chrome-headless-shell-mac-x64',
            'chrome-headless-shell'
        ),
        chromiumSuffix: path.join(
            'chromium-1234',
            'chrome-mac-x64',
            'Google Chrome for Testing.app',
            'Contents',
            'MacOS',
            'Google Chrome for Testing'
        ),
    },
    {
        platform: 'linux' as const,
        arch: 'x64' as const,
        key: 'linux-x64',
        headlessSuffix: path.join(
            'chromium_headless_shell-1234',
            'chrome-headless-shell-linux64',
            'chrome-headless-shell'
        ),
        chromiumSuffix: path.join('chromium-1234', 'chrome-linux64', 'chrome'),
    },
    {
        platform: 'win32' as const,
        arch: 'x64' as const,
        key: 'win32-x64',
        headlessSuffix: path.join(
            'chromium_headless_shell-1234',
            'chrome-headless-shell-win64',
            'chrome-headless-shell.exe'
        ),
        chromiumSuffix: path.join('chromium-1234', 'chrome-win64', 'chrome.exe'),
    },
];

for (const testCase of cases) {
    assert(
        getBundledBrowserPlatformKey(testCase.platform, testCase.arch) === testCase.key,
        `platform key mismatch for ${testCase.platform}-${testCase.arch}`
    );

    const candidates = getBundledBrowserExecutableCandidates({
        platform: testCase.platform,
        arch: testCase.arch,
        localBrowsersDir,
        browsersJson: fakeBrowsersJson,
        browsersJsonPath: path.join(localBrowsersDir, '..', 'browsers.json'),
    });

    assert(candidates.length === 2, `expected two candidates for ${testCase.key}`);
    assert(
        candidates[0].browserName === 'chromium-headless-shell',
        `headless shell should be preferred for ${testCase.key}`
    );
    assert(
        candidates[0].executablePath.endsWith(testCase.headlessSuffix),
        `unexpected headless path for ${testCase.key}: ${candidates[0].executablePath}`
    );
    assert(
        candidates[1].browserName === 'chromium',
        `chromium fallback should be second for ${testCase.key}`
    );
    assert(
        candidates[1].executablePath.endsWith(testCase.chromiumSuffix),
        `unexpected chromium path for ${testCase.key}: ${candidates[1].executablePath}`
    );
}

console.log('✅ bundled browser resolver path shapes are valid');
