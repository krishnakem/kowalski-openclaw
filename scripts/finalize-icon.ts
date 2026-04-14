
import { Jimp } from "jimp";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function finalizeIcon() {
    // Start with the clean, full-bleed version
    const iconPath = path.join(__dirname, '../build/icon-maximized.png');
    const outputPath = path.join(__dirname, '../build/icon-final.png');

    console.log(`🎨 Finalizing Icon from: ${iconPath}`);

    try {
        const image = await Jimp.read(iconPath);
        const originalWidth = image.bitmap.width; // 1024
        const originalHeight = image.bitmap.height; // 1024

        // Based on user feedback triangulation:
        // 100% = Huge
        // 75% = A bit big
        // 56% = Too small
        // Target = 62.5%
        const scaleFactor = 0.625;

        const newWidth = Math.floor(originalWidth * scaleFactor);
        const newHeight = Math.floor(originalHeight * scaleFactor);

        console.log(`Target Scale: ${scaleFactor * 100}%`);
        console.log(`Resizing content to: ${newWidth}x${newHeight}`);

        // Resize the content
        image.resize({ w: newWidth, h: newHeight });

        // Create canvas
        const canvas = new Jimp({ width: originalWidth, height: originalHeight, color: 0x00000000 });

        // Center it
        const x = (originalWidth - newWidth) / 2;
        const y = (originalHeight - newHeight) / 2;
        canvas.composite(image, x, y);

        // Apply visual rounding (Squircle) to the resized box itself?
        // If the box is white, we want it to look like a squiricle.
        // We need to apply the mask RELATIVE to the box size, OR apply a global mask?
        // If we apply a global 1024 mask to a 640px box in the center, the mask does nothing (it's inside the mask).
        // WE NEED TO MASK THE CONTENT BOX ITSELF.

        // Generate mask for the CONTENT size
        const mask = new Jimp({ width: newWidth, height: newHeight, color: 0x00000000 });
        const n = 4.8;
        const cx = newWidth / 2;
        const cy = newHeight / 2;
        const rx = newWidth / 2;
        const ry = newHeight / 2;

        for (let my = 0; my < newHeight; my++) {
            for (let mx = 0; mx < newWidth; mx++) {
                const normX = (mx - cx + 0.5) / rx;
                const normY = (my - cy + 0.5) / ry;
                const dist = Math.pow(Math.abs(normX), n) + Math.pow(Math.abs(normY), n);

                if (dist <= 1) {
                    mask.setPixelColor(0xFFFFFFFF, mx, my);
                } else {
                    mask.setPixelColor(0x00000000, mx, my);
                }
            }
        }

        // Apply mask to the resized image BEFORE compositing?
        // Note: Jimp composite handles alpha.
        // Let's Mask the resized image first.
        image.mask(mask, 0, 0);

        // Now Composite onto global canvas
        // Re-create canvas to be safe
        const finalCanvas = new Jimp({ width: originalWidth, height: originalHeight, color: 0x00000000 });
        finalCanvas.composite(image, x, y);

        await finalCanvas.write(outputPath);
        console.log(`✅ Final icon generated at: ${outputPath}`);

    } catch (error) {
        console.error("Error processing icon:", error);
        process.exit(1);
    }
}

finalizeIcon();
