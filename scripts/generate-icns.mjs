import fs from 'fs';
import path from 'path';
import { execFileSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');

// Squircle-masked, HIG-sized canvas produced by scripts/standardize-icon.ts.
// Using the raw icon.png skips the squircle/keyline mask and ships an
// un-rounded square in the dock.
const sourcePng = path.join(projectRoot, 'build', 'icon-standard.png');
const outIcns = path.join(projectRoot, 'build', 'icon.icns');
const iconsetDir = path.join(projectRoot, 'build', '.icon.iconset');

// Apple's full iconset spec — every slot macOS may ask for.
const slots = [
    { name: 'icon_16x16.png',      size: 16 },
    { name: 'icon_16x16@2x.png',   size: 32 },
    { name: 'icon_32x32.png',      size: 32 },
    { name: 'icon_32x32@2x.png',   size: 64 },
    { name: 'icon_128x128.png',    size: 128 },
    { name: 'icon_128x128@2x.png', size: 256 },
    { name: 'icon_256x256.png',    size: 256 },
    { name: 'icon_256x256@2x.png', size: 512 },
    { name: 'icon_512x512.png',    size: 512 },
    { name: 'icon_512x512@2x.png', size: 1024 },
];

if (!fs.existsSync(sourcePng)) {
    console.error(`❌ Source PNG not found: ${sourcePng}`);
    console.error(`   Run 'npx tsx scripts/standardize-icon.ts' first.`);
    process.exit(1);
}

if (fs.existsSync(iconsetDir)) fs.rmSync(iconsetDir, { recursive: true, force: true });
fs.mkdirSync(iconsetDir, { recursive: true });

// Use sips for resampling. Jimp's PNG encoder produced icns slots that
// Electron's nativeImage rejected at runtime ("Failed to load image from path").
// sips writes PNGs that Skia decodes reliably.
for (const slot of slots) {
    const out = path.join(iconsetDir, slot.name);
    execFileSync('sips', ['-z', String(slot.size), String(slot.size), sourcePng, '--out', out], { stdio: ['ignore', 'ignore', 'inherit'] });
}

if (fs.existsSync(outIcns)) fs.rmSync(outIcns);
execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', outIcns], { stdio: 'inherit' });

fs.rmSync(iconsetDir, { recursive: true, force: true });

const stat = fs.statSync(outIcns);
console.log(`✅ Generated ${path.relative(projectRoot, outIcns)} (${(stat.size / 1024).toFixed(1)} KB) via sips from ${path.relative(projectRoot, sourcePng)}`);
