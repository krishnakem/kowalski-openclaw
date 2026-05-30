import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { BrowserManager } from './BrowserManager.js';
import { Kowalski } from './Kowalski.js';
import { DigestGeneration } from './DigestGeneration.js';
import { Extractor } from './Extractor.js';
import { isOnline, isNetworkError, startOfflineWatchdog, OFFLINE_ERROR, CREDITS_DEPLETED_ERROR } from './NetworkMonitor.js';
import { CapturedPost, ExtractionBlock } from '../../types/instagram.js';
import type { KowalskiSession } from '../../core/KowalskiSession.js';

type RunStatus = 'idle' | 'running';
type RunAbortReason = 'offline' | 'timeout-stories' | 'timeout-feed' | 'external' | 'user-stop';

// RunManager is kept as a singleton (minimum-diff with Stage 1 call sites);
// bindSession is called once before startRun. The host is responsible for
// durable storage of the returned AnalysisRecord — nothing is persisted to a
// shared store anymore.
export interface AnalysisRecord {
    id: string;
    data: any;
    leadStoryPreview: string;
}

export interface RunResultMetadata {
    id: string;
    data: {
        date: string | Date;
        title: string;
        scheduledTime?: string;
        location?: string;
    };
    leadStoryPreview: string;
}

export interface RunResult {
    record: AnalysisRecord;
    metadata: RunResultMetadata;
    lastAnalysisDate: string;
    analysisStatus: 'ready';
    counts: { extracted: number; skipped: number; failed: number };
    // Phases that hit their hard cap mid-run. The success path still
    // generates a digest from partial captures; the plugin surfaces these
    // in the text header so the agent can explain what happened.
    timedOutPhases: ('stories' | 'feed')[];
}

export class RunManager {
    private static instance: RunManager;
    private session: KowalskiSession | null = null;
    private status: RunStatus = 'idle';

    // Active run state (for stop support)
    private activeScraper: Kowalski | null = null;
    private activeExtractors: Extractor[] = [];

    // Run-level abort that fires for offline detection. Fetches in Extractor
    // and DigestGeneration compose this signal into their AbortController so
    // they unblock instantly when the network drops mid-run.
    private runAbortController: AbortController | null = null;
    private offlineDetected = false;
    private stopOfflineWatchdog: (() => void) | null = null;

    // Why the current run is (or was) aborting. Set at the point of abort so
    // the catch-path partial-record writer can label the record. Cleared at
    // the start of each run.
    private abortReason: RunAbortReason | null = null;

    // Stop-marker file poller. Callers (notably the stop_run tool) drop an
    // empty file at `${scratchDir}/STOP_REQUESTED` and we pick it up at the
    // next poll, fire a cooperative stop, and finalize with a partial digest.
    private stopMarkerPoller: NodeJS.Timeout | null = null;

    private constructor() {}

    public static getInstance(): RunManager {
        if (!RunManager.instance) {
            RunManager.instance = new RunManager();
        }
        return RunManager.instance;
    }

    public bindSession(session: KowalskiSession | null): void {
        this.session = session;
    }

    private requireSession(): KowalskiSession {
        if (!this.session) {
            throw new Error('RunManager: no session bound (call bindSession first)');
        }
        return this.session;
    }

    public getStatus(): RunStatus {
        return this.status;
    }

    private emit(name: string, payload?: any): void {
        if (!this.session) return;
        if (payload === undefined) this.session.events.emit(name);
        else this.session.events.emit(name, payload);
    }

    /**
     * Called from the renderer when `navigator.onLine` flips to false — fires
     * near-instantly on OS-level network changes. Aborts every in-flight LLM
     * request so the run fails in milliseconds instead of waiting for fetch
     * timeouts. The run's catch block then classifies the failure as offline
     * and routes the UI to DigestFailedScreen.
     */
    public notifyOffline(): void {
        if (this.status !== 'running') return;
        if (this.offlineDetected) return;
        console.log('🌐 Offline detected — aborting run');
        this.offlineDetected = true;
        if (!this.abortReason) this.abortReason = 'offline';
        this.emit('analysis-error', {
            message: 'Network connection lost',
            kind: 'offline',
            canRetry: true
        });
        this.runAbortController?.abort();
        if (this.activeScraper) this.activeScraper.stop();
        for (const e of this.activeExtractors) e.stop();
    }

    /**
     * Skip the active stories phase and continue into the feed phase.
     * Only meaningful while the StoriesAgent is running; no-op otherwise.
     */
    public skipToFeed(): void {
        if (this.activeScraper) {
            console.log('⏭️  Skipping stories phase');
            this.activeScraper.skipStoriesPhase();
        }
    }

    public stopRun(): void {
        if (this.status !== 'running') {
            console.log('🛑 stopRun: no active run to stop');
            return;
        }
        if (!this.abortReason) this.abortReason = 'external';
        console.log(`🛑 Stopping active run (reason=${this.abortReason})...`);

        // Hard stop: abort any in-flight fetch to Anthropic so the run
        // can't hang waiting on a slow LLM response. This is the same
        // mechanism notifyOffline() uses, and it's what makes the
        // STOP_REQUESTED escape hatch finalize within ~30s instead of
        // whenever the current LLM turn happens to return.
        try {
            this.runAbortController?.abort();
        } catch (err) {
            console.warn('🛑 stopRun: abort controller threw (ignored)', err);
        }

        // Cooperative stop for the scraper/extractors — the agent checks
        // these flags between LLM calls and exits cleanly. The browser
        // stays open so error-handling loops don't spin on "browser
        // closed"; it closes naturally in startRun() step 8 after
        // browseAndCapture returns.
        if (this.activeScraper) {
            this.activeScraper.stop();
        }
        for (const e of this.activeExtractors) {
            e.stop();
        }
        if (!this.activeScraper && this.activeExtractors.length === 0) {
            console.log('🛑 stopRun: no scraper/extractor attached yet — abort signal will catch the next await');
        }
    }

    public async startRun(options?: { phases?: ('stories' | 'feed')[] }): Promise<RunResult | null> {
        if (this.status === 'running') {
            console.log('⚠️ Run already in progress');
            return null;
        }

        const session = this.requireSession();
        this.status = 'running';
        this.offlineDetected = false;
        this.abortReason = null;
        this.runAbortController = new AbortController();
        const phases = options?.phases ?? session.runConfig.phases ?? ['stories', 'feed'];
        console.log(`🚀 Run started (phases: ${phases.join(', ')})`);

        // Background watchdog: probes Anthropic every 1s and trips notifyOffline
        // after three consecutive failures (~1-3s to detect a real outage).
        // Three-strike threshold guards against a single dropped probe while
        // still firing well before fetch retry loops burn attempts.
        this.stopOfflineWatchdog = startOfflineWatchdog(() => {
            console.log('🌐 Offline watchdog: connectivity lost');
            this.notifyOffline();
        });

        // Stop-marker poller: the stop_run tool (or `touch` from a separate
        // terminal) creates `${scratchDir}/STOP_REQUESTED`. Checking every
        // 3 seconds keeps the "~30 seconds" user-facing promise slack even
        // if the agent is mid-LLM-call. Remove any stale marker from a
        // previous run before starting.
        const stopMarker = path.join(session.scratchDir, 'STOP_REQUESTED');
        try { fs.rmSync(stopMarker, { force: true }); } catch { /* best-effort */ }
        this.stopMarkerPoller = setInterval(() => {
            if (fs.existsSync(stopMarker)) {
                console.log('🛑 Stop marker detected — requesting graceful stop');
                if (!this.abortReason) this.abortReason = 'user-stop';
                this.stopRun();
            }
        }, 3000);

        const MAX_DURATION_MS = session.runConfig.maxDurationMs ?? 90 * 60 * 1000;
        const browserManager = BrowserManager.getInstance();
        browserManager.bindSession(session);
        let context = null;

        this.emit('run-started', {
            durationMs: MAX_DURATION_MS,
            startTime: Date.now()
        });

        // Hoisted so the catch path can load partial captures off disk and
        // still write an analysis record when the run aborts mid-flight.
        let rawStoriesDir: string | null = null;
        let rawFeedDir: string | null = null;

        try {
            // 1. Settings come from the session config (the host owns durable storage).
            const settings = session.runConfig;

            // 2. API key comes from the session.
            const apiKey = session.anthropicApiKey;
            if (!apiKey) {
                console.error('🚀 Run: NO API KEY');
                this.emitError('API key not found.');
                this.finishRun();
                return null;
            }

            // 2a. Pre-flight: confirm we can reach Anthropic before spending minutes
            // in the browser. The browse phase doesn't hit the API directly, but
            // every extraction and the digest do — and the retry loops inside
            // those services will burn attempts if the network is actually down.
            console.log('🚀 Pre-flight: checking network...');
            if (!(await isOnline())) {
                throw new Error(OFFLINE_ERROR);
            }

            // 3. Launch browser (always headless)
            console.log('🚀 Launching browser...');
            context = await browserManager.launch();

            // 4. Validate session
            console.log('🚀 Validating Instagram session...');
            const sessionCheck = await browserManager.validateSession();
            if (!sessionCheck.valid) {
                throw new Error(sessionCheck.reason || 'SESSION_EXPIRED');
            }

            // 5. Set up directories. Raw screenshots + sidecars live under
            // session.scratchDir (extractor watches them).
            const screenshotsDir = path.join(session.scratchDir, 'kowalski-runs');
            const runStart = new Date();
            const pad = (n: number) => n.toString().padStart(2, '0');
            const dateTime = `${runStart.getFullYear()}-${pad(runStart.getMonth() + 1)}-${pad(runStart.getDate())}_${pad(runStart.getHours())}-${pad(runStart.getMinutes())}-${pad(runStart.getSeconds())}`;
            const sessionDir = path.join(screenshotsDir, `run_${dateTime}`);
            rawStoriesDir = path.join(sessionDir, 'raw', 'stories');
            rawFeedDir = path.join(sessionDir, 'raw', 'feed');
            fs.mkdirSync(rawStoriesDir, { recursive: true });
            fs.mkdirSync(rawFeedDir, { recursive: true });

            // 6. Start extractor agents in background — one vision call per raw image,
            // result merged into the existing sidecar JSON in place. No filtered/ dir.
            console.log('🚀 Starting extractor agents...');
            const storiesExtractor = new Extractor(rawStoriesDir, apiKey, this.runAbortController.signal);
            const feedExtractor = new Extractor(rawFeedDir, apiKey, this.runAbortController.signal);
            this.activeExtractors = [storiesExtractor, feedExtractor];
            const storiesExtractorPromise = storiesExtractor.start();
            const feedExtractorPromise = feedExtractor.start();

            // 7. Browse Instagram
            console.log('🚀 Browsing Instagram...');
            const scraper = new Kowalski(
                context,
                apiKey,
                false,
                path.join(session.scratchDir, 'session_memory', 'summaries.json')
            );
            this.activeScraper = scraper;
            const browseSession = await scraper.browseAndCapture(
                MAX_DURATION_MS / 60000,
                {
                    rawDir: path.join(sessionDir, 'raw'),
                    phases,
                    storiesTimeoutMs: session.runConfig.storiesTimeoutMs,
                    feedTimeoutMs: session.runConfig.feedTimeoutMs,
                    onPhaseChange: (phase, info) => {
                        this.emit('run-phase', { phase, ...(info ?? {}) });
                    }
                }
            );
            this.activeScraper = null;
            console.log(`🚀 Browsing complete: ${browseSession.rawScreenshotCount} raw screenshots`);

            // Bail out early if the watchdog tripped during browsing. We must
            // not proceed to digest generation when the user has no network —
            // the UI is already on the failed screen.
            if (this.offlineDetected) throw new Error(OFFLINE_ERROR);

            // 8. Close browser before generation
            await browserManager.close();
            context = null;

            // 9. Wait for extractor agents
            console.log('🚀 Waiting for extractor agents...');
            const [storiesStats, feedStats] = await Promise.all([storiesExtractorPromise, feedExtractorPromise]);
            this.activeExtractors = [];
            const totalExtracted = storiesStats.extracted + feedStats.extracted;
            const totalSkipped = storiesStats.skipped + feedStats.skipped;
            const totalFailed = storiesStats.failed + feedStats.failed;
            console.log(`🚀 Extraction complete: ${totalExtracted} usable, ${totalSkipped} skipped, ${totalFailed} failed`);

            if (totalExtracted < 3) {
                console.warn(`🚀 Very few usable captures (${totalExtracted}), digest quality may be low`);
            }

            // 10. Load raw images + extraction sidecars. We keep skip-marked items in
            // memory so the digest prompt can decide what to do; DigestGeneration filters
            // them out before assembling the prompt.
            const loadCaptured = (dir: string, source: 'story' | 'feed') => {
                if (!fs.existsSync(dir)) return [] as Array<{ screenshot: Buffer; source: 'story' | 'feed'; imagePath: string; extraction?: ExtractionBlock }>;
                return fs.readdirSync(dir)
                    .filter((f: string) => f.endsWith('.jpg'))
                    .sort()
                    .map((filename: string) => {
                        const imagePath = path.join(dir, filename);
                        const jsonPath = path.join(dir, filename.replace('.jpg', '.json'));
                        let extraction: ExtractionBlock | undefined;
                        if (fs.existsSync(jsonPath)) {
                            try {
                                const sidecar = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
                                if (sidecar && typeof sidecar.extraction === 'object') {
                                    extraction = sidecar.extraction as ExtractionBlock;
                                }
                            } catch {
                                // ignore malformed sidecar — image still loads
                            }
                        }
                        return {
                            screenshot: fs.readFileSync(imagePath),
                            source,
                            imagePath,
                            extraction
                        };
                    });
            };
            const allCaptured = [...loadCaptured(rawStoriesDir, 'story'), ...loadCaptured(rawFeedDir, 'feed')];

            const bestCaptures = allCaptured.map((cap, index) => ({
                id: index + 1,
                screenshot: cap.screenshot,
                source: cap.source as 'feed' | 'story' | 'profile' | 'carousel',
                timestamp: Date.now(),
                scrollPosition: 0,
                imagePath: cap.imagePath,
                extraction: cap.extraction
            }));
            console.log(`🚀 Loaded ${bestCaptures.length} raw screenshots with extractions`);

            // 11. Generate digest — re-check the network first. Browsing can take
            // up to 90 min and connectivity may have dropped in that window.
            if (!(await isOnline())) {
                throw new Error(OFFLINE_ERROR);
            }
            console.log('🚀 Generating digest...');
            const digestGenerator = new DigestGeneration(apiKey);
            const analysis = await digestGenerator.generateDigest(bestCaptures, {
                userName: settings.userName || 'User',
                location: settings.location || ''
            }, this.runAbortController.signal);

            // 12. Save images to disk (under session.outputDir — host owns retention).
            const recordId = uuidv4();
            const recordDir = path.join(session.outputDir, 'analysis_records');
            const imagesDir = path.join(recordDir, recordId, 'images');
            await fs.promises.mkdir(imagesDir, { recursive: true });

            const imageMetadata: { id: number; filename: string; source: string }[] = [];
            for (const capture of bestCaptures) {
                const filename = `${capture.id}.jpg`;
                const imagePath = path.join(imagesDir, filename);
                await fs.promises.writeFile(imagePath, capture.screenshot);
                imageMetadata.push({
                    id: capture.id,
                    filename,
                    source: capture.source
                });
            }

            // 13. Save analysis JSON. When a phase hit its hard cap (or the
            // user requested a stop) we still generate the digest from the
            // partial captures, but tag the record so downstream consumers
            // know it was cut short. The run is not considered a failure —
            // the digest is real.
            const timedOutPhases = browseSession.timedOutPhases ?? [];
            const abortReason: 'timeout-stories' | 'timeout-feed' | 'user-stop' | undefined =
                this.abortReason === 'user-stop'
                    ? 'user-stop'
                    : timedOutPhases.includes('stories')
                        ? 'timeout-stories'
                        : timedOutPhases.includes('feed')
                            ? 'timeout-feed'
                            : undefined;
            const analysisWithImages = {
                ...analysis,
                images: imageMetadata,
                ...(abortReason
                    ? {
                        aborted: true,
                        abortReason,
                        metadata: {
                            ...((analysis as any).metadata ?? {}),
                            aborted: true,
                            abortReason,
                        },
                    }
                    : {})
            };
            const previewSource = analysis.markdown
                ? analysis.markdown.replace(/^#.*$/m, '').replace(/[#*_>`-]/g, '').trim().slice(0, 100)
                : analysis.sections[0]?.content[0]?.substring(0, 100);
            const newRecord = {
                id: recordId,
                data: analysisWithImages,
                leadStoryPreview: (previewSource || "No preview available.") + (previewSource ? "..." : "")
            };

            const recordPath = path.join(recordDir, `${recordId}.json`);
            const tempPath = path.join(recordDir, `${recordId}.tmp`);
            await fs.promises.writeFile(tempPath, JSON.stringify(newRecord, null, 2));
            await fs.promises.rename(tempPath, recordPath);
            console.log(`🚀 Saved digest to disk: ${recordPath}`);

            // 14. Compose metadata record. Not persisted here — returned to caller.
            const metadataRecord = {
                id: newRecord.id,
                data: {
                    date: newRecord.data.date,
                    title: newRecord.data.title,
                    scheduledTime: newRecord.data.scheduledTime,
                    location: newRecord.data.location
                },
                leadStoryPreview: newRecord.leadStoryPreview
            };

            const now = new Date();
            this.emit('analysis-ready', metadataRecord);

            console.log(`🚀 Run complete! Extracted: ${totalExtracted}, Skipped: ${totalSkipped}, Failed: ${totalFailed}`);

            // The host is responsible for durable storage of `record` +
            // `metadata`. RunManager used to write both to electron-store; now
            // it returns them and the host decides.
            this.finishRun();
            return {
                record: newRecord,
                metadata: metadataRecord,
                lastAnalysisDate: now.toISOString(),
                analysisStatus: 'ready',
                counts: {
                    extracted: totalExtracted,
                    skipped: totalSkipped,
                    failed: totalFailed
                },
                timedOutPhases: browseSession.timedOutPhases ?? []
            };

        } catch (error: any) {
            console.error('🚀 Run failed:', error.message);
            this.activeScraper = null;

            if (context) {
                await browserManager.close();
            }

            // Classify the failure. Three distinct kinds flow to the UI:
            //   - credits: Anthropic returned credit_balance_too_low
            //   - offline: pre-flight OFFLINE, watchdog tripped, or a
            //       network-layer error surfaced from a fetch
            //   - general: anything else (rendered as a log-only for now)
            const creditsDepleted = error?.message === CREDITS_DEPLETED_ERROR;
            const offline = !creditsDepleted && (this.offlineDetected || error?.message === OFFLINE_ERROR || isNetworkError(error));
            if (!this.offlineDetected) {
                if (creditsDepleted) {
                    this.emitError('Please refill your API Balance', 'credits');
                } else if (offline) {
                    this.emitError('Network connection lost', 'offline');
                } else {
                    this.emitError(`Run failed: ${error.message}`, 'general');
                }
            }

            const abortReason: RunAbortReason =
                (this.abortReason as RunAbortReason | null) ?? (offline ? 'offline' : 'external');
            this.abortReason = abortReason;

            const captureCount = this.countCapturedFiles(rawStoriesDir, rawFeedDir);

            // For graceful stops/timeouts, try to turn the captures already
            // on disk into a real digest. Use a fresh bounded signal because
            // the run-level signal is already aborted by definition here.
            const gracefulAbort =
                abortReason === 'user-stop' ||
                abortReason === 'timeout-stories' ||
                abortReason === 'timeout-feed';
            if (gracefulAbort && captureCount > 0) {
                try {
                    const result = await this.writeBestEffortDigestRecord(session, {
                        rawStoriesDir,
                        rawFeedDir,
                        abortReason,
                        errorMessage: error?.message ?? String(error),
                    });
                    if (result) {
                        this.finishRun();
                        return result;
                    }
                } catch (digestErr) {
                    console.error('🚀 Best-effort digest failed:', digestErr);
                }
            }

            // If digest synthesis failed, still return a record when any
            // capture exists so the plugin can produce a PDF and surface an
            // artifact instead of marking the run failed.
            if (captureCount > 0) {
                try {
                    const partial = await this.writePartialRecord(session, {
                        rawStoriesDir,
                        rawFeedDir,
                        abortReason,
                        errorMessage: error?.message ?? String(error),
                    });
                    this.finishRun();
                    return partial;
                } catch (writeErr) {
                    console.error('🚀 Failed to write partial record:', writeErr);
                }
            }

            // True zero-artifact failures (pre-flight offline, missing key,
            // credits before capture, etc.) still return null.
        }

        this.finishRun();
        return null;
    }

    /**
     * Scan raw capture dirs on disk and persist a minimal analysis record so
     * a run that aborted mid-flight still leaves an artifact. No digest is
     * generated — the record just lists what got captured plus an
     * `aborted: true` flag and the `abortReason` tag.
     */
    private countCapturedFiles(rawStoriesDir: string | null, rawFeedDir: string | null): number {
        const count = (dir: string | null) => {
            if (!dir || !fs.existsSync(dir)) return 0;
            return fs.readdirSync(dir).filter((f: string) => f.endsWith('.jpg')).length;
        };
        return count(rawStoriesDir) + count(rawFeedDir);
    }

    private loadBestCaptures(
        rawStoriesDir: string | null,
        rawFeedDir: string | null
    ): CapturedPost[] {
        const loadCaptured = (dir: string | null, source: 'story' | 'feed') => {
            if (!dir || !fs.existsSync(dir)) {
                return [] as Array<{ screenshot: Buffer; source: 'story' | 'feed'; imagePath: string; extraction?: ExtractionBlock }>;
            }
            return fs.readdirSync(dir)
                .filter((f: string) => f.endsWith('.jpg'))
                .sort()
                .map((filename: string) => {
                    const imagePath = path.join(dir, filename);
                    const jsonPath = path.join(dir, filename.replace('.jpg', '.json'));
                    let extraction: ExtractionBlock | undefined;
                    if (fs.existsSync(jsonPath)) {
                        try {
                            const sidecar = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
                            if (sidecar && typeof sidecar.extraction === 'object') {
                                extraction = sidecar.extraction as ExtractionBlock;
                            }
                        } catch {
                            // ignore malformed sidecar — image still loads
                        }
                    }
                    return {
                        screenshot: fs.readFileSync(imagePath),
                        source,
                        imagePath,
                        extraction
                    };
                });
        };

        return [...loadCaptured(rawStoriesDir, 'story'), ...loadCaptured(rawFeedDir, 'feed')]
            .map((cap, index) => ({
                id: index + 1,
                screenshot: cap.screenshot,
                source: cap.source as 'feed' | 'story' | 'profile' | 'carousel',
                timestamp: Date.now(),
                scrollPosition: 0,
                imagePath: cap.imagePath,
                extraction: cap.extraction
            }));
    }

    private countCaptureQuality(captures: CapturedPost[]): { extracted: number; skipped: number; failed: number } {
        let extracted = 0;
        let skipped = 0;
        let failed = 0;
        for (const capture of captures) {
            if (!capture.extraction) {
                failed++;
            } else if (capture.extraction.usefulness === 'skip') {
                skipped++;
            } else {
                extracted++;
            }
        }
        return { extracted, skipped, failed };
    }

    private metadataForRecord(record: AnalysisRecord): RunResultMetadata {
        return {
            id: record.id,
            data: {
                date: record.data.date,
                title: record.data.title,
                scheduledTime: record.data.scheduledTime,
                location: record.data.location
            },
            leadStoryPreview: record.leadStoryPreview
        };
    }

    private async writeBestEffortDigestRecord(
        session: KowalskiSession,
        opts: {
            rawStoriesDir: string | null;
            rawFeedDir: string | null;
            abortReason: 'timeout-stories' | 'timeout-feed' | 'user-stop';
            errorMessage: string;
        }
    ): Promise<RunResult | null> {
        const bestCaptures = this.loadBestCaptures(opts.rawStoriesDir, opts.rawFeedDir);
        if (bestCaptures.length === 0) return null;

        const counts = this.countCaptureQuality(bestCaptures);
        const digestGenerator = new DigestGeneration(session.anthropicApiKey);
        const digestController = new AbortController();
        const digestSignal = AbortSignal.any([
            digestController.signal,
            AbortSignal.timeout(90_000),
        ]);

        const analysis = await digestGenerator.generateDigest(bestCaptures, {
            userName: session.runConfig.userName || 'User',
            location: session.runConfig.location || ''
        }, digestSignal);

        const recordId = uuidv4();
        const recordDir = path.join(session.outputDir, 'analysis_records');
        const imagesDir = path.join(recordDir, recordId, 'images');
        await fs.promises.mkdir(imagesDir, { recursive: true });

        const imageMetadata: { id: number; filename: string; source: string }[] = [];
        for (const capture of bestCaptures) {
            const filename = `${capture.id}.jpg`;
            const imagePath = path.join(imagesDir, filename);
            await fs.promises.writeFile(imagePath, capture.screenshot);
            imageMetadata.push({
                id: capture.id,
                filename,
                source: capture.source
            });
        }

        const analysisWithImages = {
            ...analysis,
            images: imageMetadata,
            aborted: true,
            abortReason: opts.abortReason,
            metadata: {
                ...((analysis as any).metadata ?? {}),
                aborted: true,
                abortReason: opts.abortReason,
                errorMessage: opts.errorMessage,
            },
        };
        const previewSource = analysis.markdown
            ? analysis.markdown.replace(/^#.*$/m, '').replace(/[#*_>`-]/g, '').trim().slice(0, 100)
            : analysis.sections[0]?.content[0]?.substring(0, 100);
        const record: AnalysisRecord = {
            id: recordId,
            data: analysisWithImages,
            leadStoryPreview: (previewSource || 'No preview available.') + (previewSource ? '...' : '')
        };

        const recordPath = path.join(recordDir, `${recordId}.json`);
        const tempPath = path.join(recordDir, `${recordId}.tmp`);
        await fs.promises.writeFile(tempPath, JSON.stringify(record, null, 2));
        await fs.promises.rename(tempPath, recordPath);
        console.log(`🚀 Best-effort digest written: ${recordPath} (${opts.abortReason}, ${bestCaptures.length} captures)`);

        const metadata = this.metadataForRecord(record);
        this.emit('analysis-ready', metadata);
        return {
            record,
            metadata,
            lastAnalysisDate: new Date().toISOString(),
            analysisStatus: 'ready',
            counts,
            timedOutPhases: opts.abortReason === 'timeout-stories'
                ? ['stories']
                : opts.abortReason === 'timeout-feed'
                    ? ['feed']
                    : []
        };
    }

    private async writePartialRecord(
        session: KowalskiSession,
        opts: {
            rawStoriesDir: string | null;
            rawFeedDir: string | null;
            abortReason: 'offline' | 'timeout-stories' | 'timeout-feed' | 'external' | 'user-stop';
            errorMessage: string;
        }
    ): Promise<RunResult> {
        const listCaptures = (dir: string | null, source: 'story' | 'feed') => {
            if (!dir || !fs.existsSync(dir)) return [] as Array<{ source: string; filename: string; extracted: boolean }>;
            return fs.readdirSync(dir)
                .filter((f: string) => f.endsWith('.jpg'))
                .sort()
                .map((filename: string) => {
                    const jsonPath = path.join(dir, filename.replace('.jpg', '.json'));
                    let extracted = false;
                    if (fs.existsSync(jsonPath)) {
                        try {
                            const sidecar = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
                            if (sidecar && typeof sidecar.extraction === 'object') extracted = true;
                        } catch {
                            /* sidecar unreadable → count as non-extracted */
                        }
                    }
                    return { source, filename, extracted };
                });
        };

        const stories = listCaptures(opts.rawStoriesDir, 'story');
        const feed = listCaptures(opts.rawFeedDir, 'feed');
        const captures = [...stories, ...feed];
        const extractedCount = captures.filter(c => c.extracted).length;

        const recordId = uuidv4();
        const recordDir = path.join(session.outputDir, 'analysis_records');
        await fs.promises.mkdir(recordDir, { recursive: true });

        const record = {
            id: recordId,
            data: {
                aborted: true,
                abortReason: opts.abortReason,
                metadata: {
                    aborted: true,
                    abortReason: opts.abortReason,
                    errorMessage: opts.errorMessage,
                },
                errorMessage: opts.errorMessage,
                date: new Date().toISOString(),
                title: `Partial digest (${opts.abortReason})`,
                subtitle: `${captures.length} captures (${extractedCount} extracted)`,
                location: session.runConfig.location || '',
                scheduledTime: new Date().toLocaleTimeString('en-US', {
                    hour: 'numeric',
                    minute: '2-digit',
                    hour12: true
                }),
                sections: [
                    {
                        heading: 'Run stopped before digest synthesis',
                        content: [
                            `The run stopped with reason "${opts.abortReason}" after ${captures.length} captures (${extractedCount} extracted).`,
                            `Original error: ${opts.errorMessage}`,
                        ],
                    },
                ],
                markdown:
                    `# Partial digest (${opts.abortReason})\n\n` +
                    `The run stopped before digest synthesis after ${captures.length} captures (${extractedCount} extracted).\n\n` +
                    `Original error: ${opts.errorMessage}`,
                captureCounts: {
                    stories: stories.length,
                    feed: feed.length,
                    total: captures.length,
                    extracted: extractedCount,
                },
                captures,
            },
            leadStoryPreview: `Run aborted (${opts.abortReason}) after ${captures.length} captures (${extractedCount} extracted).`,
        };

        const recordPath = path.join(recordDir, `${recordId}.json`);
        const tempPath = path.join(recordDir, `${recordId}.tmp`);
        await fs.promises.writeFile(tempPath, JSON.stringify(record, null, 2));
        await fs.promises.rename(tempPath, recordPath);
        console.log(`🚀 Partial record written: ${recordPath} (${opts.abortReason}, ${captures.length} captures)`);

        const metadata = this.metadataForRecord(record);
        this.emit('analysis-ready', metadata);
        return {
            record,
            metadata,
            lastAnalysisDate: new Date().toISOString(),
            analysisStatus: 'ready',
            counts: {
                extracted: extractedCount,
                skipped: 0,
                failed: captures.length - extractedCount,
            },
            timedOutPhases: opts.abortReason === 'timeout-stories'
                ? ['stories']
                : opts.abortReason === 'timeout-feed'
                    ? ['feed']
                    : []
        };
    }

    private emitError(message: string, kind: 'offline' | 'credits' | 'general' = 'general') {
        this.emit('analysis-error', {
            message,
            kind,
            canRetry: true
        });
    }

    private finishRun() {
        this.status = 'idle';
        this.activeExtractors = [];
        if (this.stopOfflineWatchdog) {
            this.stopOfflineWatchdog();
            this.stopOfflineWatchdog = null;
        }
        if (this.stopMarkerPoller) {
            clearInterval(this.stopMarkerPoller);
            this.stopMarkerPoller = null;
        }
        if (this.session) {
            try {
                fs.rmSync(path.join(this.session.scratchDir, 'STOP_REQUESTED'), { force: true });
            } catch {
                /* best-effort cleanup */
            }
        }
        this.emit('run-complete', {});
    }
}
