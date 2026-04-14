import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import os from 'os';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/**
 * CONFIGURATION
 */
const CHROMIUM_VERSION_DIR = 'chromium-1200';
const USER_HOME = os.homedir();
const PLAYWRIGHT_CACHE_DIR = path.join(USER_HOME, 'Library/Caches/ms-playwright');
const VERSION_DIR = path.join(PLAYWRIGHT_CACHE_DIR, CHROMIUM_VERSION_DIR, 'chrome-mac-arm64');

// Paths
const SOURCE_APP_NAME = 'Google Chrome for Testing.app';
const TARGET_APP_NAME = 'Kowalski.app';
const SOURCE_APP_PATH = path.join(VERSION_DIR, SOURCE_APP_NAME);
const TARGET_APP_PATH = path.join(VERSION_DIR, TARGET_APP_NAME);

// Source Icon - HIGH RES PNG (must be at least 1024x1024)
const SOURCE_ICON_PNG = path.join(__dirname, '../build/icon.png');

// Plist
const PLIST_PATH = path.join(TARGET_APP_PATH, 'Contents/Info.plist');

/**
 * Generate a proper macOS .icns file with all Retina resolutions
 * using native sips and iconutil tools.
 */
function generateHighResIcns(sourcePng: string, outputIcns: string): boolean {
    console.log('🎨 Generating High-Resolution ICNS from source PNG...');
    console.log(`   Source: ${sourcePng}`);

    // Verify source exists and is large enough
    if (!fs.existsSync(sourcePng)) {
        console.error(`❌ Source PNG not found: ${sourcePng}`);
        return false;
    }

    // Create temporary iconset directory
    const iconsetDir = path.join(os.tmpdir(), 'Kowalski.iconset');
    if (fs.existsSync(iconsetDir)) {
        fs.rmSync(iconsetDir, { recursive: true });
    }
    fs.mkdirSync(iconsetDir);

    // Define all required icon sizes for macOS (including @2x for Retina)
    // Format: [filename, size]
    const iconSizes: [string, number][] = [
        ['icon_16x16.png', 16],
        ['icon_16x16@2x.png', 32],
        ['icon_32x32.png', 32],
        ['icon_32x32@2x.png', 64],
        ['icon_128x128.png', 128],
        ['icon_128x128@2x.png', 256],
        ['icon_256x256.png', 256],
        ['icon_256x256@2x.png', 512],
        ['icon_512x512.png', 512],
        ['icon_512x512@2x.png', 1024],
    ];

    try {
        // Generate each size using sips (native macOS image tool)
        for (const [filename, size] of iconSizes) {
            const outputPath = path.join(iconsetDir, filename);
            execSync(`sips -z ${size} ${size} "${sourcePng}" --out "${outputPath}"`, { stdio: 'pipe' });
            console.log(`   ✓ Generated ${filename} (${size}x${size})`);
        }

        // Compile iconset into icns using iconutil
        console.log('   📦 Compiling iconset with iconutil...');
        execSync(`iconutil -c icns "${iconsetDir}" -o "${outputIcns}"`, { stdio: 'pipe' });

        // Cleanup temp directory
        fs.rmSync(iconsetDir, { recursive: true });

        // Verify output
        if (fs.existsSync(outputIcns)) {
            const stats = fs.statSync(outputIcns);
            console.log(`   ✅ ICNS generated successfully: ${outputIcns} (${Math.round(stats.size / 1024)}KB)`);
            return true;
        } else {
            console.error('   ❌ ICNS file was not created');
            return false;
        }
    } catch (e) {
        console.error('   ❌ Failed to generate ICNS:', e);
        // Cleanup on failure
        if (fs.existsSync(iconsetDir)) {
            fs.rmSync(iconsetDir, { recursive: true });
        }
        return false;
    }
}

async function setupStealthBrowser() {
    console.log('🕵️‍♀️ Setting up Stealth "Kowalski" Browser with High-Res Icon...');
    console.log('');

    // 1. Verify Source App
    if (!fs.existsSync(SOURCE_APP_PATH)) {
        console.error(`❌ Source Browser not found: ${SOURCE_APP_PATH}`);
        console.error('   Run "npx playwright install chromium" first.');
        process.exit(1);
    }

    // 2. Clone App Bundle
    console.log('📦 Step 1: Cloning Browser Bundle...');
    if (fs.existsSync(TARGET_APP_PATH)) {
        console.log('   Target exists. Removing old version...');
        fs.rmSync(TARGET_APP_PATH, { recursive: true, force: true });
    }

    try {
        execSync(`cp -R "${SOURCE_APP_PATH}" "${TARGET_APP_PATH}"`);
        console.log('   ✅ Clone successful.');
    } catch (e) {
        console.error('❌ Failed to clone app:', e);
        process.exit(1);
    }
    console.log('');

    // 3. Generate and Install High-Res ICNS
    console.log('🎨 Step 2: Generating High-Resolution Icon...');
    const resourcesDir = path.join(TARGET_APP_PATH, 'Contents/Resources');
    const targetIcnsPath = path.join(resourcesDir, 'kowalski.icns');

    const iconGenerated = generateHighResIcns(SOURCE_ICON_PNG, targetIcnsPath);

    if (iconGenerated) {
        // Remove old app.icns files to prevent any confusion
        try {
            const findCmd = `find "${TARGET_APP_PATH}" -name "app.icns"`;
            const iconPaths = execSync(findCmd).toString().split('\n').filter(p => p.trim());
            iconPaths.forEach(iconPath => {
                console.log(`   Removing old: ${iconPath}`);
                fs.unlinkSync(iconPath);
            });
            if (iconPaths.length > 0) {
                console.log(`   ✅ Removed ${iconPaths.length} old app.icns file(s).`);
            }
        } catch (e) {
            // Non-critical
        }
    } else {
        console.warn('⚠️ Icon generation failed. Continuing without icon patch.');
    }
    console.log('');

    // 4. Patch Info.plist
    console.log('📝 Step 3: Patching Info.plist...');
    try {
        let plistContent = fs.readFileSync(PLIST_PATH, 'utf-8');

        // Replace display names
        plistContent = plistContent.replace(
            /<key>CFBundleDisplayName<\/key>\s*<string>Google Chrome for Testing<\/string>/g,
            '<key>CFBundleDisplayName</key>\n\t<string>Kowalski</string>'
        );
        plistContent = plistContent.replace(
            /<key>CFBundleName<\/key>\s*<string>Google Chrome for Testing<\/string>/g,
            '<key>CFBundleName</key>\n\t<string>Kowalski</string>'
        );

        // Change Bundle Identifier (CRITICAL for icon cache busting)
        plistContent = plistContent.replace(
            /<key>CFBundleIdentifier<\/key>\s*<string>com.google.chrome.for.testing<\/string>/g,
            '<key>CFBundleIdentifier</key>\n\t<string>com.kowalski.browser</string>'
        );

        // Update Icon File Reference
        plistContent = plistContent.replace(
            /<key>CFBundleIconFile<\/key>\s*<string>app.icns<\/string>/g,
            '<key>CFBundleIconFile</key>\n\t<string>kowalski.icns</string>'
        );

        fs.writeFileSync(PLIST_PATH, plistContent);
        console.log('   ✅ Updated: Display Name, Bundle ID, Icon Reference');
    } catch (e) {
        console.error('❌ Failed to patch Plist:', e);
    }
    console.log('');

    // 5. Delete Assets.car (forces macOS to use icns fallback)
    console.log('🔥 Step 4: Deleting Assets.car (Icon Override)...');
    try {
        const findAssetsCmd = `find "${TARGET_APP_PATH}" -name "Assets.car"`;
        const assetPaths = execSync(findAssetsCmd).toString().split('\n').filter(p => p.trim());

        assetPaths.forEach(assetPath => {
            fs.unlinkSync(assetPath);
        });
        console.log(`   ✅ Deleted ${assetPaths.length} Assets.car file(s).`);
    } catch (e) {
        console.warn('   ⚠️ No Assets.car files found.');
    }
    console.log('');

    // 6. Code Sign (for fast startup)
    console.log('🔏 Step 5: Code Signing App Bundle...');
    try {
        execSync(`codesign --force --deep --sign - "${TARGET_APP_PATH}"`, { stdio: 'pipe' });
        console.log('   ✅ Ad-hoc signature applied.');
    } catch (e) {
        console.warn('   ⚠️ Failed to code sign. Startup might be slow.');
    }
    console.log('');

    // 7. Force Cache Refresh
    console.log('🔄 Step 6: Forcing Icon Cache Refresh...');
    try {
        // Touch the app bundle to update modification time
        execSync(`touch "${TARGET_APP_PATH}"`);
        console.log('   ✅ Touched app bundle.');

        // Clear user icon cache (non-sudo)
        const userIconCache = path.join(USER_HOME, 'Library/Caches/com.apple.iconservices.store');
        if (fs.existsSync(userIconCache)) {
            fs.rmSync(userIconCache, { recursive: true, force: true });
            console.log('   ✅ Cleared user icon cache.');
        }

        // Restart Dock to apply changes
        execSync('killall Dock', { stdio: 'pipe' });
        console.log('   ✅ Restarted Dock.');
    } catch (e) {
        console.warn('   ⚠️ Cache refresh partially failed (non-critical).');
    }
    console.log('');

    console.log('═'.repeat(50));
    console.log('✅ Stealth Browser Setup Complete!');
    console.log('═'.repeat(50));
    console.log(`Path: ${TARGET_APP_PATH}`);
    console.log('');
    console.log('The icon should now appear crisp and identical to the main Electron app.');
}

setupStealthBrowser();
