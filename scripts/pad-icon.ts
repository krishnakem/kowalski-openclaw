
import { Jimp } from "jimp";
import path from "path";
import { fileURLToPath } from "url";

// ESM dirname fix
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function padIcon() {
    const iconPath = path.join(__dirname, '../build/icon.png');
    const outputPath = path.join(__dirname, '../build/icon-padded.png');
    console.log(`🎨 Reading source icon from: ${iconPath}`);

    try {
        const image = await Jimp.read(iconPath);
        const originalWidth = image.bitmap.width;
        const originalHeight = image.bitmap.height;

        console.log(`Dimensions: ${originalWidth}x${originalHeight}`);

        // Target: Scale down content to 82% (Standard macOS Safe Area)
        // This preserves the original file and prevents "compound shrinking"
        const scaleFactor = 0.82;
        const newWidth = Math.floor(originalWidth * scaleFactor);
        const newHeight = Math.floor(originalHeight * scaleFactor);

        console.log(`Scaling content to: ${newWidth}x${newHeight}`);

        // Resize the image content
        image.resize({ w: newWidth, h: newHeight });

        // Create a new empty transparent canvas of original size
        const canvas = new Jimp({ width: originalWidth, height: originalHeight, color: 0x00000000 });

        // Composite the resized image onto the center of the canvas
        const x = (originalWidth - newWidth) / 2;
        const y = (originalHeight - newHeight) / 2;

        canvas.composite(image, x, y);

        await canvas.write(outputPath);
        console.log(`✅ Padded icon generated at: ${outputPath}`);

    } catch (error) {
        console.error("Error processing icon:", error);
        process.exit(1);
    }
}

padIcon();
