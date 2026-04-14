/**
 * Setup script for branding Playwright's Chromium as "Kowalski"
 *
 * This script:
 * 1. Finds the installed Playwright Chromium
 * 2. Renames the app bundle to Kowalski.app
 * 3. Updates Info.plist with custom branding
 * 4. Replaces the icon with our custom icon
 * 5. Re-signs the app bundle
 *
 * Run: npx tsx scripts/setup-kowalski-browser.ts
 */

import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Configuration
const BUNDLE_NAME = 'Kowalski';
const BUNDLE_IDENTIFIER = 'com.kowalski.browser';
const ORIGINAL_BUNDLE_NAME = 'Google Chrome for Testing';

interface BrandingResult {
    success: boolean;
    message: string;
    path?: string;
}

function getPlaywrightCacheDir(): string {
    const home = os.homedir();

    if (process.platform === 'darwin') {
        return path.join(home, 'Library/Caches/ms-playwright');
    } else if (process.platform === 'win32') {
        return path.join(home, 'AppData/Local/ms-playwright');
    } else {
        return path.join(home, '.cache/ms-playwright');
    }
}

function findLatestChromiumRevision(cacheDir: string): string | null {
    if (!fs.existsSync(cacheDir)) {
        return null;
    }

    const revisions = fs.readdirSync(cacheDir)
        .filter(d => d.startsWith('chromium-') && !d.includes('headless'))
        .map(d => d.replace('chromium-', ''))
        .filter(r => !isNaN(parseInt(r, 10)))
        .sort((a, b) => parseInt(b, 10) - parseInt(a, 10));

    return revisions[0] || null;
}

function brandMacOS(cacheDir: string, revision: string): BrandingResult {
    const chromiumDir = path.join(cacheDir, `chromium-${revision}`, 'chrome-mac-arm64');

    // Check for Intel Mac
    const chromiumDirIntel = path.join(cacheDir, `chromium-${revision}`, 'chrome-mac');
    const actualChromiumDir = fs.existsSync(chromiumDir) ? chromiumDir :
                              fs.existsSync(chromiumDirIntel) ? chromiumDirIntel : null;

    if (!actualChromiumDir) {
        return { success: false, message: `Chromium directory not found at ${chromiumDir} or ${chromiumDirIntel}` };
    }

    const originalAppPath = path.join(actualChromiumDir, `${ORIGINAL_BUNDLE_NAME}.app`);
    const newAppPath = path.join(actualChromiumDir, `${BUNDLE_NAME}.app`);

    // Check if already branded
    if (fs.existsSync(newAppPath)) {
        console.log(`   ℹ️  ${BUNDLE_NAME}.app already exists`);
        // Continue to update icon and plist anyway
    } else if (!fs.existsSync(originalAppPath)) {
        return { success: false, message: `Original app not found at ${originalAppPath}` };
    } else {
        // Rename the app bundle
        console.log(`   📦 Renaming: ${ORIGINAL_BUNDLE_NAME}.app → ${BUNDLE_NAME}.app`);
        fs.renameSync(originalAppPath, newAppPath);
    }

    // Update Info.plist
    const plistPath = path.join(newAppPath, 'Contents', 'Info.plist');
    if (fs.existsSync(plistPath)) {
        console.log('   📝 Updating Info.plist...');

        // Read plist as text (it's XML)
        let plistContent = fs.readFileSync(plistPath, 'utf-8');

        // Update CFBundleName
        plistContent = plistContent.replace(
            /<key>CFBundleName<\/key>\s*<string>[^<]*<\/string>/,
            `<key>CFBundleName</key>\n\t<string>${BUNDLE_NAME}</string>`
        );

        // Update CFBundleDisplayName (if exists)
        if (plistContent.includes('CFBundleDisplayName')) {
            plistContent = plistContent.replace(
                /<key>CFBundleDisplayName<\/key>\s*<string>[^<]*<\/string>/,
                `<key>CFBundleDisplayName</key>\n\t<string>${BUNDLE_NAME}</string>`
            );
        }

        // Update CFBundleIdentifier
        plistContent = plistContent.replace(
            /<key>CFBundleIdentifier<\/key>\s*<string>[^<]*<\/string>/,
            `<key>CFBundleIdentifier</key>\n\t<string>${BUNDLE_IDENTIFIER}</string>`
        );

        fs.writeFileSync(plistPath, plistContent);
        console.log(`      - CFBundleName: ${BUNDLE_NAME}`);
        console.log(`      - CFBundleIdentifier: ${BUNDLE_IDENTIFIER}`);
    }

    // Replace icon
    const projectRoot = path.resolve(__dirname, '..');
    const sourceIcon = path.join(projectRoot, 'build', 'icon.icns');
    const destIcon = path.join(newAppPath, 'Contents', 'Resources', 'app.icns');
    const destIconChrome = path.join(newAppPath, 'Contents', 'Resources', 'chrome.icns');
    const destIconKowalski = path.join(newAppPath, 'Contents', 'Resources', 'kowalski.icns');

    if (fs.existsSync(sourceIcon)) {
        console.log('   🎨 Replacing icon...');

        // Copy to app.icns (main icon)
        fs.copyFileSync(sourceIcon, destIcon);
        console.log(`      - Copied to app.icns`);

        // Also copy to chrome.icns if it exists (Chrome uses this)
        if (fs.existsSync(destIconChrome)) {
            fs.copyFileSync(sourceIcon, destIconChrome);
            console.log(`      - Copied to chrome.icns`);
        }

        // Also copy to kowalski.icns if it exists (custom rename)
        if (fs.existsSync(destIconKowalski)) {
            fs.copyFileSync(sourceIcon, destIconKowalski);
            console.log(`      - Copied to kowalski.icns`);
        }
    } else {
        console.log(`   ⚠️  Icon not found at ${sourceIcon}, skipping icon replacement`);
    }

    // Touch the app to invalidate icon cache
    try {
        execSync(`touch "${newAppPath}"`, { stdio: 'ignore' });
    } catch {}

    // Re-sign the app
    console.log('   🔐 Re-signing app bundle...');
    try {
        execSync(`codesign --force --deep --sign - "${newAppPath}"`, { stdio: 'pipe' });
        console.log('      - Signed successfully (ad-hoc)');
    } catch (error) {
        console.log('      - ⚠️  Codesign failed (app may still work locally)');
    }

    return {
        success: true,
        message: `Successfully branded Chromium as ${BUNDLE_NAME}`,
        path: newAppPath
    };
}

function brandWindows(cacheDir: string, revision: string): BrandingResult {
    const chromiumDir = path.join(cacheDir, `chromium-${revision}`, 'chrome-win');

    if (!fs.existsSync(chromiumDir)) {
        return { success: false, message: `Chromium directory not found at ${chromiumDir}` };
    }

    const originalExe = path.join(chromiumDir, 'chrome.exe');
    const newExe = path.join(chromiumDir, `${BUNDLE_NAME}.exe`);

    if (fs.existsSync(newExe)) {
        console.log(`   ℹ️  ${BUNDLE_NAME}.exe already exists`);
        return { success: true, message: 'Already branded', path: newExe };
    }

    if (!fs.existsSync(originalExe)) {
        return { success: false, message: `Original exe not found at ${originalExe}` };
    }

    // Rename the executable
    console.log(`   📦 Renaming: chrome.exe → ${BUNDLE_NAME}.exe`);
    fs.renameSync(originalExe, newExe);

    // Try to update icon with rcedit if available
    const projectRoot = path.resolve(__dirname, '..');
    const sourceIcon = path.join(projectRoot, 'build', 'icon.ico');

    if (fs.existsSync(sourceIcon)) {
        console.log('   🎨 Attempting to update icon...');
        try {
            execSync(`npx rcedit "${newExe}" --set-icon "${sourceIcon}"`, { stdio: 'pipe' });
            execSync(`npx rcedit "${newExe}" --set-product-name "${BUNDLE_NAME}"`, { stdio: 'pipe' });
            console.log('      - Icon and product name updated');
        } catch {
            console.log('      - ⚠️  rcedit not available, skipping icon update');
        }
    }

    return {
        success: true,
        message: `Successfully branded Chromium as ${BUNDLE_NAME}`,
        path: newExe
    };
}

function brandLinux(cacheDir: string, revision: string): BrandingResult {
    const chromiumDir = path.join(cacheDir, `chromium-${revision}`, 'chrome-linux');

    if (!fs.existsSync(chromiumDir)) {
        return { success: false, message: `Chromium directory not found at ${chromiumDir}` };
    }

    const originalExe = path.join(chromiumDir, 'chrome');
    const newExe = path.join(chromiumDir, BUNDLE_NAME);

    if (fs.existsSync(newExe)) {
        console.log(`   ℹ️  ${BUNDLE_NAME} already exists`);
        return { success: true, message: 'Already branded', path: newExe };
    }

    if (!fs.existsSync(originalExe)) {
        return { success: false, message: `Original executable not found at ${originalExe}` };
    }

    // Rename the executable
    console.log(`   📦 Renaming: chrome → ${BUNDLE_NAME}`);
    fs.renameSync(originalExe, newExe);

    return {
        success: true,
        message: `Successfully branded Chromium as ${BUNDLE_NAME}`,
        path: newExe
    };
}

async function main() {
    console.log('');
    console.log('🔧 Kowalski Browser Setup');
    console.log('='.repeat(50));
    console.log('');

    // 1. Find Playwright cache
    console.log('🔍 Detecting Playwright Chromium installation...');
    const cacheDir = getPlaywrightCacheDir();

    if (!fs.existsSync(cacheDir)) {
        console.log('');
        console.log('❌ Playwright cache not found at:', cacheDir);
        console.log('');
        console.log('   Please install Playwright Chromium first:');
        console.log('   npx playwright install chromium');
        console.log('');
        process.exit(1);
    }

    // 2. Find latest revision
    const revision = findLatestChromiumRevision(cacheDir);

    if (!revision) {
        console.log('');
        console.log('❌ No Chromium installation found in:', cacheDir);
        console.log('');
        console.log('   Please install Playwright Chromium first:');
        console.log('   npx playwright install chromium');
        console.log('');
        process.exit(1);
    }

    console.log(`   Found Chromium revision: ${revision}`);
    console.log(`   Cache directory: ${cacheDir}`);
    console.log('');

    // 3. Apply branding based on platform
    console.log(`📦 Applying ${BUNDLE_NAME} branding (${process.platform})...`);

    let result: BrandingResult;

    switch (process.platform) {
        case 'darwin':
            result = brandMacOS(cacheDir, revision);
            break;
        case 'win32':
            result = brandWindows(cacheDir, revision);
            break;
        case 'linux':
            result = brandLinux(cacheDir, revision);
            break;
        default:
            result = { success: false, message: `Unsupported platform: ${process.platform}` };
    }

    console.log('');

    if (result.success) {
        console.log('✅ ' + result.message);
        if (result.path) {
            console.log(`   Path: ${result.path}`);
        }

        // macOS: Clear icon cache hint
        if (process.platform === 'darwin') {
            console.log('');
            console.log('💡 If icon appears cached/blurry, run:');
            console.log('   sudo rm -rf /Library/Caches/com.apple.iconservices.store');
            console.log('   killall Finder');
        }
    } else {
        console.log('❌ ' + result.message);
        process.exit(1);
    }

    console.log('');
}

main().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
});
