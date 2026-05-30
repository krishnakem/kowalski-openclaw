import { tsImport } from 'tsx/esm/api';

const resolver = await tsImport(
    '../src/main/services/BundledBrowserResolver.ts',
    import.meta.url
);

const {
    getBundledBrowserExecutableCandidates,
    getPlaywrightChromiumBrowserInfo,
    resolveBundledBrowser,
} = resolver;

try {
    const info = getPlaywrightChromiumBrowserInfo();
    const browser = resolveBundledBrowser();
    const expectedCandidate = getBundledBrowserExecutableCandidates().find(
        (candidate) =>
            candidate.browserName === browser.browserName &&
            candidate.revision === browser.revision
    );
    const expectedEntry =
        browser.browserName === 'chromium-headless-shell'
            ? info.chromiumHeadlessShell
            : info.chromium;

    if (!expectedCandidate || browser.revision !== expectedEntry.revision) {
        throw new Error('Resolved browser did not match playwright-core/browsers.json.');
    }

    if (!browser.isExecutable) {
        throw new Error(`Bundled Chromium exists but is not executable: ${browser.executablePath}`);
    }

    console.log(`Bundled Chromium OK: ${browser.executablePath}`);
    console.log(`Browser: ${browser.browserName}`);
    console.log(`Revision: ${browser.revision}`);
    console.log(`Version: ${browser.browserVersion ?? 'unknown'}`);
    console.log(`browsers.json: ${info.browsersJsonPath}`);
} catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
}
