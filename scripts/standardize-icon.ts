
import { Jimp } from "jimp";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function standardizeIcon() {
    // 1. Source: The clean, full-bleed content (100% zoom)
    const iconPath = path.join(__dirname, '../build/icon-maximized.png');
    const outputPath = path.join(__dirname, '../build/icon-standard.png');

    console.log(`🍎 Standardizing Icon to Apple HIG Grid...`);

    try {
        const image = await Jimp.read(iconPath);

        // Apple HIG Specification for macOS 11+
        // Canvas: 1024x1024
        // Keyline Shape (Squircle): 824x824
        // (This allows room for the drop shadow)
        const CANVAS_SIZE = 1024;
        const TARGET_SIZE = 824;

        console.log(`Target Content Size: ${TARGET_SIZE}x${TARGET_SIZE}`);

        // 2. Resize content to the standard App Icon Box size
        image.resize({ w: TARGET_SIZE, h: TARGET_SIZE });

        // 2b. Flatten the background. The source artwork has a subtle radial
        // gradient (lighter top-left, darker bottom-right) that reads as
        // "gloss" and contributes to a soft/blurry perception in the dock.
        // Average all light pixels to pick a single flat color, then repaint
        // every light pixel with it. Foreground (dark) pixels are untouched.
        const LUMA_THRESHOLD = 128; // pixels above this are considered background
        let bgR = 0, bgG = 0, bgB = 0, bgCount = 0;
        for (let y = 0; y < TARGET_SIZE; y++) {
            for (let x = 0; x < TARGET_SIZE; x++) {
                const c = image.getPixelColor(x, y);
                const r = (c >>> 24) & 0xFF;
                const g = (c >>> 16) & 0xFF;
                const b = (c >>> 8) & 0xFF;
                const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                if (luma >= LUMA_THRESHOLD) { bgR += r; bgG += g; bgB += b; bgCount++; }
            }
        }
        const flatR = Math.round(bgR / bgCount);
        const flatG = Math.round(bgG / bgCount);
        const flatB = Math.round(bgB / bgCount);
        const flatColor = ((flatR << 24) | (flatG << 16) | (flatB << 8) | 0xFF) >>> 0;
        for (let y = 0; y < TARGET_SIZE; y++) {
            for (let x = 0; x < TARGET_SIZE; x++) {
                const c = image.getPixelColor(x, y);
                const r = (c >>> 24) & 0xFF;
                const g = (c >>> 16) & 0xFF;
                const b = (c >>> 8) & 0xFF;
                const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
                if (luma >= LUMA_THRESHOLD) image.setPixelColor(flatColor, x, y);
            }
        }
        console.log(`Flat background: rgb(${flatR}, ${flatG}, ${flatB})`);

        // 3. Create the Shape Mask (Apple Superellipse)
        // We mask the 824x824 content directly
        const mask = new Jimp({ width: TARGET_SIZE, height: TARGET_SIZE, color: 0x00000000 });
        const n = 4.8; // Apple's continuos curve factor
        const cx = TARGET_SIZE / 2;
        const cy = TARGET_SIZE / 2;
        const rx = TARGET_SIZE / 2;
        const ry = TARGET_SIZE / 2;

        // Supersample 2x with a soft falloff so the squircle edge has true
        // anti-aliasing. A binary mask aliases badly when sips downsamples the
        // 1024 source to 16/32/64 reps, which reads as "blurry" in the dock.
        const SS = 2;
        for (let y = 0; y < TARGET_SIZE; y++) {
            for (let x = 0; x < TARGET_SIZE; x++) {
                let coverage = 0;
                for (let sy = 0; sy < SS; sy++) {
                    for (let sx = 0; sx < SS; sx++) {
                        const px = x + (sx + 0.5) / SS;
                        const py = y + (sy + 0.5) / SS;
                        const normX = (px - cx) / rx;
                        const normY = (py - cy) / ry;
                        const dist = Math.pow(Math.abs(normX), n) + Math.pow(Math.abs(normY), n);
                        if (dist <= 1) coverage++;
                    }
                }
                // Jimp.mask() reads brightness (RGB), not alpha, so encode
                // coverage as a gray level with the alpha channel fully on.
                const v = Math.round((coverage / (SS * SS)) * 255);
                const color = ((v << 24) | (v << 16) | (v << 8) | 0xFF) >>> 0;
                mask.setPixelColor(color, x, y);
            }
        }

        // Apply mask to the content
        image.mask(mask, 0, 0);

        // 4. Place on the 1024x1024 Canvas
        const canvas = new Jimp({ width: CANVAS_SIZE, height: CANVAS_SIZE, color: 0x00000000 });
        const x = (CANVAS_SIZE - TARGET_SIZE) / 2;
        const y = (CANVAS_SIZE - TARGET_SIZE) / 2;

        // Important: Standard macOS icons have a subtle drop shadow. 
        // We can simulate a basic one or leave it flat. 
        // For strict "Standardization", sticking to the size is step 1.
        // Let's create a shadow layer for professional polish.

        // Simple shadow simulation:
        // Create a black copy of the shape, blur it, reduce opacity, place it behind.
        // (Jimp blur is expensive/slow in JS, skipping blur for speed unless requested).
        // Sticking to crisp sizing for now.

        canvas.composite(image, x, y);

        await canvas.write(outputPath);
        console.log(`✅ Standardized icon generated at: ${outputPath}`);

    } catch (error) {
        console.error("Error processing icon:", error);
        process.exit(1);
    }
}

standardizeIcon();
