import { app, BrowserWindow } from 'electron';
import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import { BrowserManager } from './BrowserManager.js';
import { Kowalski } from './Kowalski.js';
import { DigestGeneration } from './DigestGeneration.js';
import { Extractor } from './Extractor.js';
import { SecureKeyManager } from './SecureKeyManager.js';
import { isOnline, isNetworkError, startOfflineWatchdog, OFFLINE_ERROR, CREDITS_DEPLETED_ERROR } from './NetworkMonitor.js';
import { ExtractionBlock } from '../../types/instagram.js';

const __filename = decodeURIComponent(new URL(import.meta.url).pathname);
const __dirname = path.dirname(__filename);

type RunStatus = 'idle' | 'running';

export class RunManager {
    private static instance: RunManager;
    private mainWindow: BrowserWindow | null = null;
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

    private constructor() {}

    public static getInstance(): RunManager {
        if (!RunManager.instance) {
            RunManager.instance = new RunManager();
        }
        return RunManager.instance;
    }

    public setMainWindow(window: BrowserWindow | null) {
        this.mainWindow = window;
    }

    public getStatus(): RunStatus {
        return this.status;
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
        // Emit the failed-screen event immediately. If we waited for the run
        // to unwind first, the browser close would fire `screencast:onEnded`
        // and AgentActiveScreen would briefly flip to "Generating digest"
        // before the error arrived.
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('analysis-error', {
                message: 'Network connection lost',
                kind: 'offline',
                canRetry: true
            });
        }
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
        if (this.activeScraper) {
            console.log('🛑 Stopping active run...');
            // Cooperative stop: sets a flag the agent checks between LLM calls.
            // The agent finishes its current action, sees the flag, and exits.
            // The browser stays open so the agent's error-handling loops don't
            // spin on "browser closed" errors — it closes naturally in startRun()
            // step 8 after browseAndCapture returns.
            this.activeScraper.stop();
        }
        for (const e of this.activeExtractors) {
            e.stop();
        }
        if (!this.activeScraper && this.activeExtractors.length === 0) {
            console.log('🛑 No active run to stop');
        }
    }

    public async startRun(options?: { phases?: ('stories' | 'feed')[] }): Promise<void> {
        if (this.status === 'running') {
            console.log('⚠️ Run already in progress');
            return;
        }

        this.status = 'running';
        this.offlineDetected = false;
        this.runAbortController = new AbortController();
        const phases = options?.phases ?? ['stories', 'feed'];
        console.log(`🚀 Run started (phases: ${phases.join(', ')})`);

        // Background watchdog: probes Anthropic every 2s and trips notifyOffline
        // after two consecutive failures (~4-6s to detect a real outage). This
        // is the reliable path — navigator.onLine in Electron/macOS can lag.
        this.stopOfflineWatchdog = startOfflineWatchdog(() => {
            console.log('🌐 Offline watchdog: connectivity lost');
            this.notifyOffline();
        });

        const MAX_DURATION_MS = 90 * 60 * 1000;
        const browserManager = BrowserManager.getInstance();
        let context = null;

        // Notify UI that run started
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('run-started', {
                durationMs: MAX_DURATION_MS,
                startTime: Date.now()
            });
        }

        try {
            // 1. Get store & settings
            const { default: Store } = await import('electron-store');
            const store: any = new Store();
            const settings = store.get('settings') || {};

            // 2. Get API Key
            const apiKey = await SecureKeyManager.getInstance().getKey();
            if (!apiKey) {
                console.error('🚀 Run: NO API KEY');
                this.emitError('API key not found.');
                this.finishRun();
                return;
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

            // 5. Set up directories
            // Raw screenshots + sidecars live in userData (extractor watches them).
            // Previously under ~/Downloads/kowalski-debug; moved out so runs don't
            // accumulate files in the user's Downloads folder.
            const screenshotsDir = path.join(app.getPath('userData'), 'kowalski-runs');
            const runStart = new Date();
            const pad = (n: number) => n.toString().padStart(2, '0');
            const dateTime = `${runStart.getFullYear()}-${pad(runStart.getMonth() + 1)}-${pad(runStart.getDate())}_${pad(runStart.getHours())}-${pad(runStart.getMinutes())}-${pad(runStart.getSeconds())}`;
            const sessionDir = path.join(screenshotsDir, `run_${dateTime}`);
            const rawStoriesDir = path.join(sessionDir, 'raw', 'stories');
            const rawFeedDir = path.join(sessionDir, 'raw', 'feed');
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
            const scraper = new Kowalski(context, apiKey, false);
            this.activeScraper = scraper;
            const session = await scraper.browseAndCapture(
                MAX_DURATION_MS / 60000,
                {
                    rawDir: path.join(sessionDir, 'raw'),
                    phases,
                    onPhaseChange: (phase, info) => {
                        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                            this.mainWindow.webContents.send('run-phase', { phase, ...(info ?? {}) });
                        }
                    }
                }
            );
            this.activeScraper = null;
            console.log(`🚀 Browsing complete: ${session.rawScreenshotCount} raw screenshots`);

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

            // 12. Save images to disk
            const recordId = uuidv4();
            const userDataPath = app.getPath('userData');
            const recordDir = path.join(userDataPath, 'analysis_records');
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

            // 13. Save analysis JSON
            const analysisWithImages = { ...analysis, images: imageMetadata };
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

            // 14. Save metadata to store
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

            const currentAnalyses = store.get('analyses') || [];
            store.set('analyses', [metadataRecord, ...currentAnalyses]);

            // 15. Update status to ready
            const now = new Date();
            store.set('settings', {
                ...store.get('settings'),
                lastAnalysisDate: now.toISOString(),
                analysisStatus: 'ready'
            });

            // 16. Notify UI
            if (this.mainWindow && !this.mainWindow.isDestroyed()) {
                this.mainWindow.webContents.send('analysis-ready', metadataRecord);
            }

            console.log(`🚀 Run complete! Extracted: ${totalExtracted}, Skipped: ${totalSkipped}, Failed: ${totalFailed}`);

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
        }

        this.finishRun();
    }

    private emitError(message: string, kind: 'offline' | 'credits' | 'general' = 'general') {
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('analysis-error', {
                message,
                kind,
                canRetry: true
            });
        }
    }

    private finishRun() {
        this.status = 'idle';
        this.activeExtractors = [];
        if (this.stopOfflineWatchdog) {
            this.stopOfflineWatchdog();
            this.stopOfflineWatchdog = null;
        }
        if (this.mainWindow && !this.mainWindow.isDestroyed()) {
            this.mainWindow.webContents.send('run-complete', {});
        }
    }
}
