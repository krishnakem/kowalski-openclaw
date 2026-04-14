
import { Jimp } from "jimp";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function analyzeIcon() {
    const iconPath = path.join(__dirname, '../build/icon.png');
    console.log(`🔍 Analyzing icon: ${iconPath}`);

    try {
        const image = await Jimp.read(iconPath);
        const originalWidth = image.bitmap.width;
        const originalHeight = image.bitmap.height;

        // AutoCrop to find true bounds
        const cropped = image.clone().autocrop();
        const contentWidth = cropped.bitmap.width;
        const contentHeight = cropped.bitmap.height;

        console.log(`Original Dimensions: ${originalWidth}x${originalHeight}`);
        console.log(`Visible Content: ${contentWidth}x${contentHeight}`);

        const wastedX = originalWidth - contentWidth;
        const wastedY = originalHeight - contentHeight;

        console.log(`Wasted Space: X=${wastedX}px, Y=${wastedY}px`);

        if (wastedX > 10 || wastedY > 10) {
            console.log("⚠️ Significant transparent padding detected!");

            // Generate "Maximized" version
            console.log("🚀 Generating maximized version (cropping whitespace)...");
            cropped.resize({ w: 1024, h: 1024 });

            const maximizedPath = path.join(__dirname, '../build/icon-maximized.png');
            await cropped.write(maximizedPath);
            console.log(`✅ Maximized icon saved to: ${maximizedPath}`);
        } else {
            console.log("✅ Icon is already mostly full-bleed.");
        }

    } catch (error) {
        console.error("Error analyzing icon:", error);
    }
}

analyzeIcon();
