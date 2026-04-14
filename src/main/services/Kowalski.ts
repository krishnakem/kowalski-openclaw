/**
 * Kowalski - Orchestration Layer
 *
 * Manages the session lifecycle: page creation, login verification,
 * session memory, and capture collection. No LLM calls — pure coordination.
 *
 * Phase 1: StoriesAgent (Haiku) — bounded stories browsing
 * Phase 2: FeedAgent (Sonnet) — feed browsing with remaining time budget
 * Phase 3: Digest generation (handled downstream by RunManager)
 */

import { BrowserContext, Page } from 'playwright';
import { app } from 'electron';
import { GhostMouse } from './GhostMouse.js';
import { HumanScroll } from './HumanScroll.js';
import { UsageService } from './UsageService.js';
import { ScreenshotCollector } from './ScreenshotCollector.js';
import { StoriesAgent } from './StoriesAgent.js';
import { FeedAgent } from './FeedAgent.js';
import { SessionMemory } from './SessionMemory.js';
import { BrowserManager } from './BrowserManager.js';
import * as path from 'path';
import { BrowsingSession } from '../../types/instagram.js';
import { ModelConfig } from '../../shared/modelConfig.js';
import type { NavigationLoopConfig } from '../../types/navigation.js';
import type { SessionSummary } from '../../types/session-memory.js';
import type { BaseVisionAgent } from './BaseVisionAgent.js';

export class Kowalski {
    private context: BrowserContext;
    private apiKey: string;
    private usageService: UsageService;
    private debugMode: boolean;

    // Layer instances (created per-session)
    private ghost!: GhostMouse;
    private scroll!: HumanScroll;
    private screenshotCollector!: ScreenshotCollector;
    private page!: Page;

    private sessionMemory: SessionMemory = new SessionMemory();
    private activeAgent: BaseVisionAgent | null = null;
    private stopped: boolean = false;

    constructor(context: BrowserContext, apiKey: string, debugMode: boolean = false) {
        this.context = context;
        this.apiKey = apiKey;
        this.usageService = UsageService.getInstance();
        this.debugMode = debugMode;
    }

    /** Stop the active browsing agent externally (e.g. Cmd+Shift+K). */
    stop(): void {
        this.stopped = true;
        // Tear down the screencast immediately so the renderer gets the ended signal
        // right away, rather than waiting for the agent to cooperatively exit.
        BrowserManager.getInstance().stopScreencast();
        if (this.activeAgent) {
            this.activeAgent.stop();
        }
    }

    /**
     * Skip the active stories agent and proceed to the feed phase. Unlike stop(),
     * this leaves `this.stopped` false so the outer loop continues into Phase 2.
     */
    skipStoriesPhase(): void {
        if (this.activeAgent) {
            this.activeAgent.stop();
        }
    }

    /**
     * Main entry point — browse Instagram and return captured screenshots.
     */
    async browseAndCapture(
        targetMinutes: number,
        config?: Partial<NavigationLoopConfig>
    ): Promise<BrowsingSession> {
        return this.browseWithAINavigation(targetMinutes, config);
    }

    /**
     * Browse Instagram using phased agents (StoriesAgent → FeedAgent).
     */
    async browseWithAINavigation(
        targetMinutes: number,
        config?: Partial<NavigationLoopConfig>
    ): Promise<BrowsingSession> {
        const startTime = Date.now();
        const targetDurationMs = targetMinutes * 60 * 1000;

        // Reuse the existing page if it's already on Instagram
        const existingPages = this.context.pages();
        const instagramPage = existingPages.find(p => p.url().includes('instagram.com'));
        this.page = instagramPage || await this.context.newPage();

        // Start live screencast to renderer
        await BrowserManager.getInstance().startScreencast(this.page);

        // Initialize physics layer
        this.ghost = new GhostMouse(this.page);
        this.scroll = new HumanScroll(this.page);

        // Initialize screenshot collector
        const estimatedMaxCaptures = Math.max(150, Math.ceil(targetMinutes * 4));
        this.screenshotCollector = new ScreenshotCollector(this.page, {
            maxCaptures: estimatedMaxCaptures,
            jpegQuality: 85,
            minScrollDelta: Math.round((this.page.viewportSize()?.height || 1920) * 0.10),
            // Debug-only screenshot/log dump to ~/Downloads/kowalski-debug — disabled.
            // saveToDirectory: path.join(app.getPath('downloads'), 'kowalski-debug')
        });

        let totalRawScreenshots = 0;
        let totalDecisions = 0;

        try {
            // 1. Navigate to Instagram (skip if already there from validateSession)
            const currentUrl = this.page.url();
            if (!currentUrl.includes('instagram.com') || currentUrl.includes('/accounts/login')) {
                console.log('🌐 Navigating to Instagram...');
                await this.page.goto('https://www.instagram.com/', {
                    waitUntil: 'domcontentloaded'
                });
                await this.humanDelay(2000, 4000);
            } else {
                console.log('🌐 Already on Instagram, reusing existing page');
            }

            // 2. Check for login redirect
            const pageUrl = this.page.url();
            console.log('📊 Page URL:', pageUrl);

            if (pageUrl.includes('/accounts/login')) {
                throw new Error('SESSION_EXPIRED');
            }

            // Natural mouse settle
            const vp = this.page.viewportSize();
            if (vp) {
                await this.ghost.hover(
                    { x: vp.width * (0.35 + Math.random() * 0.3), y: vp.height * (0.2 + Math.random() * 0.3) },
                    300 + Math.random() * 400
                );
                await this.ghost.hover(
                    { x: vp.width * (0.4 + Math.random() * 0.2), y: vp.height * (0.4 + Math.random() * 0.3) },
                    200 + Math.random() * 300
                );
            }

            console.log('\n👁️  ═══════════════════════════════════════');
            console.log('👁️  MULTI-AGENT PIPELINE ACTIVE');
            console.log('👁️  ═══════════════════════════════════════\n');

            // 3. Load cross-session memory
            await this.sessionMemory.loadMemory();
            const sessionMemoryDigest = this.sessionMemory.generateDigest();

            // 4. Write session header to log
            this.screenshotCollector.appendLogRaw(`# Session Log`);
            this.screenshotCollector.appendLogRaw(`**Started:** ${new Date().toISOString()}`);
            this.screenshotCollector.appendLogRaw(`**Budget:** ${targetMinutes} minutes`);
            this.screenshotCollector.appendLogRaw(`**Stories Model:** ${ModelConfig.stories}`);
            this.screenshotCollector.appendLogRaw(`**Feed Model:** ${ModelConfig.navigation}`);
            this.screenshotCollector.appendLogRaw(`**Mode:** Multi-agent (StoriesAgent → FeedAgent)`);
            this.screenshotCollector.appendLogRaw(`\n---\n`);

            // Determine raw directories
            const baseRawDir = config?.rawDir;
            const storiesRawDir = baseRawDir ? path.join(baseRawDir, 'stories') : undefined;
            const feedRawDir = baseRawDir ? path.join(baseRawDir, 'feed') : undefined;

            // Determine which phases to run
            const phases = config?.phases ?? ['stories', 'feed'];
            const onPhaseChange = config?.onPhaseChange;
            let storiesElapsed = 0;

            // ═══════════════════════════════════════════
            // Phase 1: Stories (Haiku — bounded, cheap)
            // ═══════════════════════════════════════════
            if (phases.includes('stories') && !this.stopped) {
                const storiesMaxMs = Infinity; // No time limit — stories end when the ArrowRight button disappears
                console.log(`\n📖 Phase 1: Stories (no time limit — exits when stories end, model: ${ModelConfig.stories})`);
                this.screenshotCollector.appendLogRaw(`\n## Phase 1: Stories\n`);
                onPhaseChange?.('stories');

                const storiesAgent = new StoriesAgent(
                    this.page, this.ghost, this.scroll, this.screenshotCollector,
                    {
                        apiKey: this.apiKey,
                        maxDurationMs: storiesMaxMs,
                        debugMode: this.debugMode,
                        sessionMemoryDigest,
                        rawDir: storiesRawDir,
                    }
                );
                this.activeAgent = storiesAgent;
                const storiesResult = await storiesAgent.run();

                totalRawScreenshots += storiesResult.rawScreenshotCount;
                totalDecisions += storiesResult.decisionCount;
                storiesElapsed = Date.now() - startTime;

                console.log(`📖 Stories phase complete: ${storiesResult.rawScreenshotCount} screenshots, ${storiesResult.decisionCount} decisions`);
            } else {
                console.log('📖 Skipping stories phase');
            }

            // ═══════════════════════════════════════════
            // Phase 2: Feed (Sonnet — remaining budget)
            // ═══════════════════════════════════════════
            if (phases.includes('feed') && !this.stopped) {
                // Hard cap on the feed phase for testing — once it elapses the
                // FeedAgent exits cooperatively and the run proceeds to digest.
                const FEED_PHASE_MAX_MS = 30 * 60 * 1000;
                const remainingMs = targetDurationMs - (Date.now() - startTime);
                const feedMaxMs = Math.min(remainingMs, FEED_PHASE_MAX_MS);

                if (feedMaxMs > 30000) { // Only run feed if >30s remaining
                    console.log(`\n📰 Phase 2: Feed (budget: ${(feedMaxMs / 1000 / 60).toFixed(1)} min, model: ${ModelConfig.navigation})`);
                    this.screenshotCollector.appendLogRaw(`\n## Phase 2: Feed\n`);
                    onPhaseChange?.('feed', { maxDurationMs: feedMaxMs });

                    const feedAgent = new FeedAgent(
                        this.page, this.ghost, this.scroll, this.screenshotCollector,
                        {
                            apiKey: this.apiKey,
                            maxDurationMs: feedMaxMs,
                            debugMode: this.debugMode,
                            sessionMemoryDigest,
                            rawDir: feedRawDir,
                        }
                    );
                    this.activeAgent = feedAgent;
                    const feedResult = await feedAgent.run();

                    totalRawScreenshots += feedResult.rawScreenshotCount;
                    totalDecisions += feedResult.decisionCount;

                    console.log(`📰 Feed phase complete: ${feedResult.rawScreenshotCount} screenshots, ${feedResult.decisionCount} decisions`);
                } else {
                    console.log('📰 Skipping feed phase — insufficient time remaining');
                }
            } else {
                console.log('📰 Skipping feed phase');
            }

            // 6. Write session summary to log
            this.screenshotCollector.appendLogRaw(`\n---\n\n## Summary`);
            this.screenshotCollector.appendLogRaw(`- **Total Decisions:** ${totalDecisions}`);
            this.screenshotCollector.appendLogRaw(`- **Total Raw Screenshots:** ${totalRawScreenshots}`);
            this.screenshotCollector.appendLogRaw(`- **Duration:** ${((Date.now() - startTime) / 1000 / 60).toFixed(1)} minutes`);
            this.screenshotCollector.flushSessionLog();

            // 7. Save cross-session memory
            const sessionSummary: SessionSummary = {
                id: `session-${startTime}`,
                timestamp: startTime,
                durationMs: Date.now() - startTime,
                interestResults: [],
                phaseBreakdown: [
                    {
                        phase: 'stories',
                        durationMs: storiesElapsed,
                        capturesProduced: phases.includes('stories') ? totalRawScreenshots : 0
                    },
                    {
                        phase: 'feed',
                        durationMs: Date.now() - startTime - storiesElapsed,
                        capturesProduced: phases.includes('feed') ? totalRawScreenshots : 0
                    }
                ],
                stagnationEvents: [],
                totalCaptures: totalRawScreenshots,
                totalActions: totalDecisions,
                uniqueContentRatio: 1.0
            };
            await this.sessionMemory.saveSession(sessionSummary);

        } catch (error: any) {
            console.error('❌ Navigation error:', error.message);
            if (['SESSION_EXPIRED', 'RATE_LIMITED', 'OFFLINE', 'CREDITS_DEPLETED'].includes(error.message)) {
                throw error;
            }
        } finally {
            this.activeAgent = null;
            await BrowserManager.getInstance().stopScreencast();

            // Log summary
            console.log(`\n📊 Session Summary:`);
            console.log(`   - Total decisions: ${totalDecisions}`);
            console.log(`   - Total raw screenshots: ${totalRawScreenshots}`);

            this.screenshotCollector.logSummary();
            await this.page.close();
        }

        return {
            captures: [],  // No longer populated here — filter agent handles this
            videos: [],
            sessionDuration: Date.now() - startTime,
            rawScreenshotCount: totalRawScreenshots,
            captureCount: 0,
            videoCount: 0,
            scrapedAt: new Date().toISOString()
        };
    }

    // =========================================================================
    // Utilities
    // =========================================================================

    private humanDelay(min: number, max: number): Promise<void> {
        const delay = min + Math.random() * (max - min);
        return new Promise(resolve => setTimeout(resolve, delay));
    }
}