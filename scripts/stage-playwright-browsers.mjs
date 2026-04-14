import fs from 'fs';
import path from 'path';
import os from 'os';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const stageRoot = path.join(projectRoot, 'build-resources', 'playwright-browsers');

function playwrightCacheDir() {
    const home = os.homedir();
    if (process.platform === 'darwin') return path.join(home, 'Library/Caches/ms-playwright');
    if (process.platform === 'win32') return path.join(home, 'AppData/Local/ms-playwright');
    return path.join(home, '.cache/ms-playwright');
}

function findLatestChromiumDir(cacheDir) {
    if (!fs.existsSync(cacheDir)) return null;
    const entries = fs.readdirSync(cacheDir)
        .filter(d => d.startsWith('chromium-') && !d.includes('headless'))
        .map(d => ({ name: d, rev: parseInt(d.replace('chromium-', ''), 10) }))
        .filter(e => !Number.isNaN(e.rev))
        .sort((a, b) => b.rev - a.rev);
    return entries[0]?.name ?? null;
}

function ensureChromiumInstalled(cacheDir) {
    const existing = findLatestChromiumDir(cacheDir);
    if (existing) return existing;
    console.log('📥 Installing Playwright Chromium (not found in cache)...');
    execSync('npx playwright install chromium', { stdio: 'inherit' });
    const after = findLatestChromiumDir(cacheDir);
    if (!after) throw new Error('Failed to install Playwright Chromium');
    return after;
}

function copyDir(src, dst) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
        const s = path.join(src, entry.name);
        const d = path.join(dst, entry.name);
        if (entry.isSymbolicLink()) {
            const link = fs.readlinkSync(s);
            fs.symlinkSync(link, d);
        } else if (entry.isDirectory()) {
            copyDir(s, d);
        } else {
            fs.copyFileSync(s, d);
            try {
                const mode = fs.statSync(s).mode;
                fs.chmodSync(d, mode);
            } catch {}
        }
    }
}

function main() {
    const cacheDir = playwrightCacheDir();
    const chromiumDirName = ensureChromiumInstalled(cacheDir);

    const src = path.join(cacheDir, chromiumDirName);
    const dst = path.join(stageRoot, chromiumDirName);

    if (fs.existsSync(stageRoot)) {
        fs.rmSync(stageRoot, { recursive: true, force: true });
    }
    fs.mkdirSync(stageRoot, { recursive: true });

    console.log(`📦 Staging ${chromiumDirName} → ${path.relative(projectRoot, dst)}`);
    copyDir(src, dst);
    console.log('✅ Playwright browsers staged for packaging.');
}

main();
