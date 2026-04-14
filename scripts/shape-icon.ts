
import { Jimp } from "jimp";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function shapeIcon() {
    // INPUT: The maximized (whitespace-cropped) version
    const iconPath = path.join(__dirname, '../build/icon-maximized.png');
    // OUTPUT: The final shaped version
    const outputPath = path.join(__dirname, '../build/icon-shaped.png');

    console.log(`🎨 Reading MAXIMIZED source icon from: ${iconPath}`);

    try {
        const image = await Jimp.read(iconPath);
        const width = image.bitmap.width;
        const height = image.bitmap.height;

        console.log(`Dimensions: ${width}x${height}`);
        console.log("📐 Generating macOS Superellipse (Squircle) Mask...");

        const mask = new Jimp({ width, height, color: 0x00000000 });

        const n = 4.8;
        const cx = width / 2;
        const cy = height / 2;
        const rx = width / 2;
        const ry = height / 2;

        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const normX = (x - cx + 0.5) / rx;
                const normY = (y - cy + 0.5) / ry;
                const dist = Math.pow(Math.abs(normX), n) + Math.pow(Math.abs(normY), n);

                if (dist <= 1) {
                    mask.setPixelColor(0xFFFFFFFF, x, y);
                } else {
                    mask.setPixelColor(0x00000000, x, y);
                }
            }
        }

        console.log("🎭 Applying Mask...");
        image.mask(mask, 0, 0);

        await image.write(outputPath);
        console.log(`✅ Shaped icon generated at: ${outputPath}`);

    } catch (error) {
        console.error("Error processing icon:", error);
        process.exit(1);
    }
}

shapeIcon();
