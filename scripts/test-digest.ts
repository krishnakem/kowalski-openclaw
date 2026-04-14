/**
 * Iterate on the digest prompt without burning vision credits or running the browser.
 *
 * Default mode: re-runs DigestGeneration on a previously captured run directory using
 * the extraction sidecars already on disk. No vision calls. Cheap Haiku iteration.
 *
 * Re-extract mode: re-runs the Extractor on every raw screenshot first (burns Sonnet
 * credits) and then runs digest. Use this when you change the extraction prompt.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/test-digest.ts <run-dir>
 *   ANTHROPIC_API_KEY=sk-ant-... npx tsx scripts/test-digest.ts <run-dir> --re-extract
 *
 *   <run-dir> is a directory under ~/Downloads/kowalski-debug/ — e.g.
 *   ~/Downloads/kowalski-debug/run_2026-04-13_19-05-24
 */

import fs from 'fs';
import path from 'path';
import { DigestGeneration } from '../src/main/services/DigestGeneration.js';
import { Extractor } from '../src/main/services/Extractor.js';
import { CapturedPost, ExtractionBlock } from '../src/types/instagram.js';

async function main() {
    const args = process.argv.slice(2);
    const reExtract = args.includes('--re-extract');
    const runDir = args.find(a => !a.startsWith('--'));

    if (!runDir) {
        console.error('Usage: tsx scripts/test-digest.ts <run-dir> [--re-extract]');
        process.exit(1);
    }

    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
        console.error('ANTHROPIC_API_KEY env var required');
        process.exit(1);
    }

    if (!fs.existsSync(runDir)) {
        console.error(`Run directory not found: ${runDir}`);
        process.exit(1);
    }

    const rawStoriesDir = path.join(runDir, 'raw', 'stories');
    const rawFeedDir = path.join(runDir, 'raw', 'feed');

    if (reExtract) {
        console.log('🧠 Re-extraction requested — running Extractor on raw screenshots...');
        // Drop the navigator's done.marker check by writing one ourselves so the
        // extractor exits after sweeping all existing files.
        for (const dir of [rawStoriesDir, rawFeedDir]) {
            if (!fs.existsSync(dir)) continue;
            const marker = path.join(dir, 'done.marker');
            if (!fs.existsSync(marker)) fs.writeFileSync(marker, JSON.stringify({ source: 'test-digest', ts: Date.now() }));
            const extractor = new Extractor(dir, apiKey);
            const stats = await extractor.start();
            console.log(`   ${path.basename(dir)}: ${stats.extracted} extracted, ${stats.skipped} skipped, ${stats.failed} failed`);
        }
    }

    const captures: CapturedPost[] = [
        ...loadDir(rawStoriesDir, 'story'),
        ...loadDir(rawFeedDir, 'feed')
    ];

    if (captures.length === 0) {
        console.error('No screenshots found in raw/stories or raw/feed');
        process.exit(1);
    }

    const withExtraction = captures.filter(c => c.extraction).length;
    console.log(`📦 Loaded ${captures.length} screenshots (${withExtraction} with extractions)`);

    const digestGen = new DigestGeneration(apiKey);
    const analysis = await digestGen.generateDigest(captures, {
        userName: 'TestUser',
        location: ''
    });

    const outJson = path.join(runDir, 'digest.json');
    const outMd = path.join(runDir, 'digest.md');
    fs.writeFileSync(outJson, JSON.stringify(analysis, null, 2));
    fs.writeFileSync(outMd, analysis.markdown || '');

    console.log(`✅ Wrote ${outJson}`);
    console.log(`✅ Wrote ${outMd}`);
    console.log(`\n--- Title: ${analysis.title} ---`);
    console.log(analysis.subtitle);
}

function loadDir(dir: string, source: 'story' | 'feed'): CapturedPost[] {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
        .filter(f => f.endsWith('.jpg'))
        .sort()
        .map((filename, idx) => {
            const imagePath = path.join(dir, filename);
            const jsonPath = path.join(dir, filename.replace('.jpg', '.json'));
            let extraction: ExtractionBlock | undefined;
            if (fs.existsSync(jsonPath)) {
                try {
                    const sidecar = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
                    if (sidecar?.extraction) extraction = sidecar.extraction as ExtractionBlock;
                } catch {}
            }
            return {
                id: idx + 1,
                screenshot: fs.readFileSync(imagePath),
                source,
                timestamp: Date.now(),
                scrollPosition: 0,
                imagePath,
                extraction
            };
        });
}

main().catch(err => {
    console.error('❌ test-digest failed:', err);
    process.exit(1);
});
