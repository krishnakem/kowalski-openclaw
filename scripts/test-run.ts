/**
 * Smoke test for the post-Stage-2 core pipeline.
 *
 * Builds a KowalskiSession against a previously-logged-in browser profile,
 * binds the singleton BrowserManager + RunManager to it, runs a stories-only
 * pass, and prints every event the session emits along the way.
 *
 * Skips cleanly if ANTHROPIC_API_KEY or KOWALSKI_PROFILE_DIR is missing — the
 * profile dir must contain valid IG cookies (use the plugin login tool first).
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-ant-... KOWALSKI_PROFILE_DIR=~/.kowalski/browser \
 *     npm run test:run
 */

import path from 'node:path';
import { createKowalskiSession } from '../src/core/KowalskiSession.js';
import { BrowserManager } from '../src/main/services/BrowserManager.js';
import { RunManager } from '../src/main/services/RunManager.js';
import { UsageService } from '../src/main/services/UsageService.js';

async function main(): Promise<void> {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    const profileDir = process.env.KOWALSKI_PROFILE_DIR;

    if (!apiKey) {
        console.log('⏭  SKIPPED: ANTHROPIC_API_KEY env var not set');
        return;
    }
    if (!profileDir) {
        console.log('⏭  SKIPPED: KOWALSKI_PROFILE_DIR env var not set (use the plugin login tool first)');
        return;
    }

    const { session } = createKowalskiSession({
        anthropicApiKey: apiKey,
        browserProfileDir: profileDir,
        runConfig: { phases: ['stories'] },
    });

    console.log('📂 scratchDir :', session.scratchDir);
    console.log('📂 outputDir  :', session.outputDir);
    console.log('📂 profileDir :', session.browserProfileDir);
    console.log('');

    UsageService.getInstance().configure(session.scratchDir);

    let frameCount = 0;
    session.events.on('frame', () => {
        frameCount++;
        if (frameCount % 30 === 0) console.log(`[frame] count=${frameCount}`);
    });
    session.events.on('screencastEnded', () => console.log('[screencastEnded]'));
    session.events.on('loginScreencastReady', () => console.log('[loginScreencastReady]'));
    session.events.on('loginSuccess', () => console.log('[loginSuccess]'));
    session.events.on('run-started', (p: any) => console.log('[run-started]', p));
    session.events.on('run-phase', (p: any) => console.log('[run-phase]', p));
    session.events.on('analysis-ready', (p: any) =>
        console.log('[analysis-ready]', { id: p?.id, title: p?.data?.title })
    );
    session.events.on('analysis-error', (p: any) => console.log('[analysis-error]', p));
    session.events.on('run-complete', () => console.log('[run-complete]'));

    BrowserManager.getInstance().bindSession(session);
    RunManager.getInstance().bindSession(session);

    const result = await RunManager.getInstance().startRun({ phases: ['stories'] });

    console.log('');
    console.log(`📦 frames received: ${frameCount}`);

    if (!result) {
        console.error('❌ Run returned null (failed or already in progress) — see [analysis-error] above');
        process.exit(1);
    }

    console.log('');
    console.log('✅ Run complete');
    console.log('   counts            :', result.counts);
    console.log('   lastAnalysisDate  :', result.lastAnalysisDate);
    console.log('   analysisStatus    :', result.analysisStatus);
    console.log('   record id         :', result.record.id);
    console.log('   record path       :', path.join(session.outputDir, 'analysis_records', `${result.record.id}.json`));
}

main().catch(err => {
    console.error('❌ test-run failed:', err);
    process.exit(1);
});
