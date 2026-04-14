
import { Jimp } from "jimp";
import path from "path";
import { fileURLToPath } from "url";
import { execSync } from "child_process";
import fs from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function generateNativeIcons() {
    // Input: The User Requested "icon.png" (1024x1024)
    const inputPath = path.join(__dirname, '../build/icon.png');

    // Output extensions
    const iconsetDir = path.join(__dirname, '../build/Kowalski.iconset');
    const icnsPath = path.join(__dirname, '../build/icon.icns');

    console.log(`🍎 Native Icon Generation triggered.`);
    console.log(`Input: ${inputPath}`);

    if (fs.existsSync(iconsetDir)) {
        fs.rmSync(iconsetDir, { recursive: true, force: true });
    }
    fs.mkdirSync(iconsetDir);

    try {
        const image = await Jimp.read(inputPath);

        // Standard macOS Iconset definitions
        const sizes = [
            { size: 16, name: 'icon_16x16.png' },
            { size: 32, name: 'icon_16x16@2x.png' },
            { size: 32, name: 'icon_32x32.png' },
            { size: 64, name: 'icon_32x32@2x.png' },
            { size: 128, name: 'icon_128x128.png' },
            { size: 256, name: 'icon_128x128@2x.png' },
            { size: 256, name: 'icon_256x256.png' },
            { size: 512, name: 'icon_256x256@2x.png' },
            { size: 512, name: 'icon_512x512.png' },
            { size: 1024, name: 'icon_512x512@2x.png' }
        ];

        console.log("📐 Resizing for iconset...");

        for (const def of sizes) {
            const resized = image.clone().resize({ w: def.size, h: def.size });
            const out = path.join(iconsetDir, def.name);
            await resized.write(out);
            // console.log(`   - Generated ${def.name}`);
        }

        console.log("📦 Packing .icns with iconutil...");
        execSync(`iconutil -c icns "${iconsetDir}" -o "${icnsPath}"`);

        console.log(`✅ Native ICNS generated at: ${icnsPath}`);

        // Cleanup
        fs.rmSync(iconsetDir, { recursive: true, force: true });

    } catch (error) {
        console.error("❌ Error generating native icons:", error);
        process.exit(1);
    }
}

generateNativeIcons();
