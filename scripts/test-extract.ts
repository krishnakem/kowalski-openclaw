/**
 * Run the Extractor on a single image (or a directory of images) for prompt tuning.
 *
 * Writes/overwrites the sidecar JSON next to each image and prints the extraction.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/test-extract.ts <path-to-jpg-or-dir>
 */

import fs from 'fs';
import path from 'path';
import { Extractor } from '../src/main/services/Extractor.js';

async function main() {
    const target = process.argv[2];
    if (!target) {
        console.error('Usage: tsx scripts/test-extract.ts <path-to-jpg-or-dir>');
        process.exit(1);
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        console.error('ANTHROPIC_API_KEY env var required');
        process.exit(1);
    }

    if (!fs.existsSync(target)) {
        console.error(`Target not found: ${target}`);
        process.exit(1);
    }

    const stat = fs.statSync(target);
    let dir: string;

    if (stat.isFile()) {
        // Run extractor on a temp dir containing only this image.
        if (!target.endsWith('.jpg')) {
            console.error('Single-file mode requires a .jpg path');
            process.exit(1);
        }
        const sourceDir = path.dirname(target);
        const filename = path.basename(target);

        // Write a done.marker so the extractor exits after this file.
        const marker = path.join(sourceDir, 'done.marker');
        const markerExisted = fs.existsSync(marker);
        if (!markerExisted) fs.writeFileSync(marker, JSON.stringify({ source: 'test-extract', ts: Date.now() }));

        const extractor = new ExtractorSingle(sourceDir, apiKey, filename);
        await extractor.start();
        if (!markerExisted) fs.unlinkSync(marker);

        const sidecar = JSON.parse(fs.readFileSync(path.join(sourceDir, filename.replace('.jpg', '.json')), 'utf-8'));
        console.log('\n--- extraction ---');
        console.log(JSON.stringify(sidecar.extraction, null, 2));
        return;
    }

    dir = target;
    const marker = path.join(dir, 'done.marker');
    const markerExisted = fs.existsSync(marker);
    if (!markerExisted) fs.writeFileSync(marker, JSON.stringify({ source: 'test-extract', ts: Date.now() }));
    const extractor = new Extractor(dir, apiKey);
    const stats = await extractor.start();
    if (!markerExisted) fs.unlinkSync(marker);
    console.log(`\n${stats.extracted} extracted, ${stats.skipped} skipped, ${stats.failed} failed`);
}

/** Subclass that processes only one specific filename. */
class ExtractorSingle extends Extractor {
    private targetFile: string;
    constructor(rawDir: string, apiKey: string, targetFile: string) {
        super(rawDir, apiKey);
        this.targetFile = targetFile;
    }
    async start() {
        // Mark every other file as already-processed so the loop only touches our target.
        const dir = (this as any).rawDir as string;
        const others = fs.readdirSync(dir).filter(f => f.endsWith('.jpg') && f !== this.targetFile);
        for (const o of others) (this as any).processed.add(o);
        return super.start();
    }
}

main().catch(err => {
    console.error('❌ test-extract failed:', err);
    process.exit(1);
});
