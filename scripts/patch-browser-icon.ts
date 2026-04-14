import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * PATH CONFIGURATION
 * We hardcode the path based on our previous investigation.
 * If Playwright updates its version, this path will need updating (or we can make it dynamic later).
 */
const CHROMIUM_VERSION_DIR = 'chromium-1200'; // Found via 'ls' in task 249
const SOURCE_ICON_PATH = path.join(__dirname, '../build/icon.icns');

const USER_HOME = os.homedir();
const PLAYWRIGHT_CACHE_DIR = path.join(USER_HOME, 'Library/Caches/ms-playwright');
const TARGET_APP_PATH = path.join(
    PLAYWRIGHT_CACHE_DIR,
    CHROMIUM_VERSION_DIR,
    'chrome-mac-arm64/Google Chrome for Testing.app'
);
const TARGET_ICON_PATH = path.join(TARGET_APP_PATH, 'Contents/Resources/app.icns');

async function patchIcon() {
    console.log('🎭 Kowalski Icon Patcher for Playwright Chromium');

    // 1. Verify Source Icon
    if (!fs.existsSync(SOURCE_ICON_PATH)) {
        console.error(`❌ Source icon not found at: ${SOURCE_ICON_PATH}`);
        process.exit(1);
    }
    console.log(`✅ Source Icon found: ${SOURCE_ICON_PATH}`);

    // 2. Verify Target App
    if (!fs.existsSync(TARGET_ICON_PATH)) {
        console.error(`❌ Target icon not found at: ${TARGET_ICON_PATH}`);
        console.error('   Have you run "npx playwright install chromium"?');
        process.exit(1);
    }
    console.log(`✅ Target Browser found: ${TARGET_APP_PATH}`);

    // 3. Backup Original (One-time)
    const backupPath = TARGET_ICON_PATH + '.bak';
    if (!fs.existsSync(backupPath)) {
        fs.copyFileSync(TARGET_ICON_PATH, backupPath);
        console.log('📦 Created backup of original icon.');
    }

    // 4. Overwrite
    try {
        fs.copyFileSync(SOURCE_ICON_PATH, TARGET_ICON_PATH);
        console.log('🎨 Icon text replaced successfully.');
    } catch (err) {
        console.error('❌ Failed to copy icon:', err);
        process.exit(1);
    }

    // 5. Touch App to Refresh Cache
    try {
        execSync(`touch "${TARGET_APP_PATH}"`);
        console.log('✨ Touched app bundle to refresh Dock cache.');
    } catch (err) {
        console.error('⚠️ Failed to touch app bundle:', err);
    }

    console.log('🎉 Done! The Playwright browser should now use the Kowalski icon.');
}

patchIcon();
