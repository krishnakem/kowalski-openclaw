import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const pluginDir = path.resolve(scriptDir, '..');
const playwrightCli = path.join(pluginDir, 'node_modules', 'playwright', 'cli.js');

if (!fs.existsSync(playwrightCli)) {
    console.error('Playwright CLI is missing. Run `npm install` in the plugin directory first.');
    process.exit(1);
}

console.log('Installing bundled Playwright Chromium into node_modules/playwright-core/.local-browsers');

const result = spawnSync(process.execPath, [playwrightCli, 'install', 'chromium'], {
    cwd: pluginDir,
    stdio: 'inherit',
    env: {
        ...process.env,
        PLAYWRIGHT_BROWSERS_PATH: '0',
    },
});

if (result.error) {
    console.error(result.error);
    process.exit(1);
}

process.exit(result.status ?? 1);
