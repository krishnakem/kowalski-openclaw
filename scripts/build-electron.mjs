import * as esbuild from 'esbuild';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

// Build main process
await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/main/main.ts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile: path.join(rootDir, 'dist-electron/main/main.cjs'),
    external: [
        'electron',
        'playwright',
        'playwright-extra',
        'playwright-core',
        'puppeteer-extra-plugin-stealth',
        'electron-store',
        'uuid',
        'better-sqlite3'
    ],
    format: 'cjs',
    sourcemap: true,
    loader: { '.md': 'text' },
    // Inject CJS shims at the top of the bundle
    banner: {
        js: `
// CJS shims for ESM compatibility
const { fileURLToPath: __fileURLToPath } = require('url');
const __importMetaUrl = require('url').pathToFileURL(__filename).toString();
`
    },
    define: {
        // Replace import.meta.url with our shim variable
        'import.meta.url': '__importMetaUrl'
    }
});

// Build preload script
await esbuild.build({
    entryPoints: [path.join(rootDir, 'src/preload/preload.cts')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    outfile: path.join(rootDir, 'dist-electron/preload/preload.cjs'),
    external: ['electron'],
    format: 'cjs',
    sourcemap: true
});

console.log('✅ Electron build complete');
