/**
 * Run the Extractor on a single image (or a directory of images) for prompt tuning.
 *
 * Writes/overwrites the sidecar JSON next to each image and prints the extraction.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/test-extract.ts <path-to-jpg-or-dir>
 *
 * Fixture assumption: the target must be an existing .jpg file or a directory
 * containing .jpg files. The script does not capture screenshots itself.
 */

import fs from 'fs';
import path from 'path';
import { Extractor } from '../src/main/services/Extractor.js';
import { UsageService } from '../src/main/services/UsageService.js';
import { createKowalskiSession } from '../src/core/KowalskiSession.js';

async function main() {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        console.log('⏭  SKIPPED: ANTHROPIC_API_KEY env var not set');
        return;
    }

    const target = process.argv[2];
    if (!target) {
        console.log('⏭  SKIPPED: no target provided. Usage: tsx scripts/test-extract.ts <path-to-jpg-or-dir>');
        return;
    }

    if (!fs.existsSync(target)) {
        console.error(`Target not found: ${target}`);
        process.exit(1);
    }

    const { session } = createKowalskiSession({ anthropicApiKey: apiKey });
    UsageService.getInstance().configure(session.scratchDir);

    const stat = fs.statSync(target);
    let dir: string;

    if (stat.isFile()) {
        if (!target.endsWith('.jpg')) {
            console.error('Single-file mode requires a .jpg path');
            process.exit(1);
        }
        const sourceDir = path.dirname(target);
        const filename = path.basename(target);

        const marker = path.join(sourceDir, 'done.marker');
        const markerExisted = fs.existsSync(marker);
        if (!markerExisted) fs.writeFileSync(marker, JSON.stringify({ source: 'test-extract', ts: Date.now() }));

        const extractor = new ExtractorSingle(sourceDir, session.anthropicApiKey, filename);
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
    const extractor = new Extractor(dir, session.anthropicApiKey);
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
