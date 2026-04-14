/**
 * ScreenshotCollector - Screenshot-First Content Capture
 *
 * Captures screenshots of each post/story during natural browsing.
 * Screenshots are accumulated in memory and batch-processed at session end.
 *
 * Key principles:
 * - NO Vision API calls during browsing (just capture)
 * - Viewport-only screenshots (not full page)
 * - Memory-aware with configurable limits
 * - Scroll position tracking for deduplication
 */

import { Page } from 'playwright';
import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Jimp } from 'jimp';
import { CapturedPost, /* CapturedVideo, */ CaptureSource } from '../../types/instagram.js';

/**
 * Configuration for screenshot collection.
 */
interface CollectorConfig {
    maxCaptures: number;      // Maximum screenshots to store
    jpegQuality: number;      // JPEG compression quality (1-100)
    minScrollDelta: number;   // Minimum scroll distance to consider new content
    saveToDirectory?: string; // Optional: path to save screenshots for debugging
}

const DEFAULT_CONFIG: CollectorConfig = {
    maxCaptures: 200,         // Generous limit — LLM controls capture decisions
    jpegQuality: 85,          // Good balance of quality and size
    minScrollDelta: 100       // Must scroll at least 100px for new capture
};

export class ScreenshotCollector {
    private page: Page;

    /** Rebind to a different page (used for tab switching). */
    setPage(page: Page): void {
        this.page = page;
    }
    private captures: CapturedPost[] = [];
    // private capturedVideos: CapturedVideo[] = [];  // VIDEO RECORDING DISABLED
    private config: CollectorConfig;
    private lastScrollPosition: number = 0;
    private outputDir: string | null = null;

    // Deduplication tracking
    private capturedHashes = new Set<string>();       // Track by perceptual image hash (primary dedup)
    private capturedPositions = new Set<string>();    // Track by source + scroll position bucket
    private lastCaptureSource: string = '';

    // File naming: posts get sequential numbers, carousel slides get sub-numbers (001.1, 001.2, ...)
    private postNumber: number = 0;
    private carouselSlideIndex: number = 0;   // 0 = not in carousel, 1+ = slide count
    private lastPostSource: CaptureSource = 'feed';
    private lastSingleFilepath: string = '';

    // Session log buffer (written to .md file alongside screenshots)
    private logBuffer: string[] = [];
    private sessionStartTime: number = Date.now();

    constructor(page: Page, config: Partial<CollectorConfig> = {}) {
        this.page = page;
        this.config = { ...DEFAULT_CONFIG, ...config };

        // Set up output directory for debugging if specified
        // Creates a session-specific subfolder for each browsing session
        if (this.config.saveToDirectory) {
            const now = new Date();
            const pad = (n: number) => n.toString().padStart(2, '0');
            const dateTime = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}_${pad(now.getHours())}-${pad(now.getMinutes())}-${pad(now.getSeconds())}`;
            this.outputDir = path.join(this.config.saveToDirectory, `run_${dateTime}`);
            this.ensureOutputDir();
            console.log(`📸 Debug screenshots will be saved to: ${this.outputDir}`);
        }
    }

    /** Get the session root directory (used for session log). */
    getOutputDir(): string | null {
        return this.outputDir;
    }

    /** Get the nav/ subdirectory for debug screenshots (used by Scroller — legacy). */
    getNavDir(): string | null {
        if (!this.outputDir) return null;
        const navDir = path.join(this.outputDir, 'nav');
        if (!fs.existsSync(navDir)) fs.mkdirSync(navDir, { recursive: true });
        return navDir;
    }

    /** Get per-agent debug directory (e.g. run_<date>/stories/ or run_<date>/feed/). */
    getAgentDebugDir(agentName: string): string | null {
        if (!this.outputDir) return null;
        const phaseName = agentName.replace(/Agent$/i, '').toLowerCase();
        const agentDir = path.join(this.outputDir, phaseName);
        if (!fs.existsSync(agentDir)) fs.mkdirSync(agentDir, { recursive: true });
        return agentDir;
    }

    /** Get the digest/ subdirectory for content captures. */
    private getDigestDir(): string | null {
        if (!this.outputDir) return null;
        const digestDir = path.join(this.outputDir, 'digest');
        if (!fs.existsSync(digestDir)) fs.mkdirSync(digestDir, { recursive: true });
        return digestDir;
    }

    /**
     * Ensure the output directory exists for saving screenshots.
     */
    private ensureOutputDir(): void {
        if (this.outputDir && !fs.existsSync(this.outputDir)) {
            fs.mkdirSync(this.outputDir, { recursive: true });
        }
    }

    /**
     * Save a screenshot to disk for debugging.
     * Only saves if outputDir is configured.
     */
    private saveScreenshotToDisk(screenshot: Buffer, source: CaptureSource): void {
        const digestDir = this.getDigestDir();
        if (!digestDir) return;

        let filename: string;

        if (source === 'carousel') {
            if (this.carouselSlideIndex === 0) {
                // First carousel slide — rename the parent capture to .1
                if (this.lastSingleFilepath && fs.existsSync(this.lastSingleFilepath)) {
                    const renamedFilename = `${this.postNumber.toString().padStart(3, '0')}.1_${this.lastPostSource}.jpg`;
                    fs.renameSync(this.lastSingleFilepath, path.join(digestDir, renamedFilename));
                    console.log(`  💾 Renamed: ${path.basename(this.lastSingleFilepath)} → ${renamedFilename}`);
                }
                this.carouselSlideIndex = 1;
            }
            this.carouselSlideIndex++;
            filename = `${this.postNumber.toString().padStart(3, '0')}.${this.carouselSlideIndex}_${this.lastPostSource}.jpg`;
        } else {
            this.postNumber++;
            this.carouselSlideIndex = 0;
            this.lastPostSource = source;
            filename = `${this.postNumber.toString().padStart(3, '0')}_${source}.jpg`;
        }

        const filepath = path.join(digestDir, filename);
        fs.writeFileSync(filepath, screenshot);

        if (source !== 'carousel') {
            this.lastSingleFilepath = filepath;
        }

        console.log(`  💾 Saved: digest/${filename}`);
    }

    /**
     * Capture the current viewport as a post screenshot.
     * Called after each scroll/story view when content is visible.
     *
     * Dedup pipeline (vision-pure — no URL or DOM queries):
     *   1. Position bucket: scroll position scoped by source type
     *   2. Scroll delta: feed-only, minimum 100px since last capture
     *   3. Perceptual hash: 8x8 greyscale image similarity (primary dedup)
     *
     * @param source - Where this content came from (LLM-declared: feed, story, carousel)
     * @param interest - Unused, kept for interface compatibility
     * @param clip - Optional viewport crop region from LLM coordinates
     * @returns true if captured, false if skipped (max reached or duplicate)
     */
    async captureCurrentPost(source: CaptureSource, clip?: { x: number; y: number; width: number; height: number }): Promise<boolean> {
        // Check memory limit
        if (this.captures.length >= this.config.maxCaptures) {
            console.log(`[CAPTURE-REJECT] max_captures: limit ${this.config.maxCaptures} reached`);
            return false;
        }

        // Get current scroll position for deduplication
        const scrollPosition = await this.getScrollPosition();

        // POSITION-BASED DEDUP: Track by source type + scroll position bucket
        const vpSize = this.page.viewportSize();
        const bucketSize = vpSize ? Math.round(vpSize.height * 0.078) : 75;
        const positionBucket = Math.round(scrollPosition / bucketSize);
        const positionKey = `${source}:${positionBucket}`;
        if (source !== 'carousel' && source !== 'story' && this.capturedPositions.has(positionKey)) {
            console.log(`[CAPTURE-REJECT] position_dedup: bucket ${positionBucket} key=${positionKey}`);
            return false;
        }

        // Skip if we haven't scrolled enough (likely same content) - for feed only, same source only
        const onSamePage = source === this.lastCaptureSource;
        if (onSamePage && source === 'feed' && Math.abs(scrollPosition - this.lastScrollPosition) < this.config.minScrollDelta) {
            console.log(`[CAPTURE-REJECT] scroll_delta: ${Math.abs(scrollPosition - this.lastScrollPosition)}px < ${this.config.minScrollDelta}px min`);
            return false;
        }

        try {
            // Cropped screenshot if clip region provided, otherwise full viewport
            const screenshot = await this.page.screenshot({
                type: 'jpeg',
                quality: this.config.jpegQuality,
                fullPage: false,  // Viewport only
                ...(clip ? { clip } : {})
            });

            // PRIMARY DEDUP: Perceptual hash — catches near-duplicates (scroll jitter, compression)
            // Stories use tighter threshold (3) because dark background dominates the 8x8 hash,
            // causing different story frames to appear similar at the default threshold (8)
            const hash = await this.computePerceptualHash(screenshot);
            const hashThreshold = source === 'story' ? 3 : 5;
            if (this.isSimilarToExisting(hash, hashThreshold)) {
                console.log(`[CAPTURE-REJECT] perceptual_hash: ${hash} (source=${source}, threshold=${hashThreshold})`);
                return false;
            }

            // Store capture
            this.captures.push({
                id: this.captures.length + 1,
                screenshot,
                source,
                timestamp: Date.now(),
                scrollPosition
            });

            // Track for deduplication
            this.capturedHashes.add(hash);
            if (source !== 'carousel' && source !== 'story') {
                this.capturedPositions.add(positionKey);
            }

            // Update last position and source for feed content
            this.lastCaptureSource = source;
            if (source === 'feed') {
                this.lastScrollPosition = scrollPosition;
            }

            // Save to disk for debugging if configured
            this.saveScreenshotToDisk(screenshot, source);

            console.log(`📸 Captured #${this.captures.length} (${source})`);
            return true;

        } catch (error) {
            console.error('📸 Screenshot capture failed:', error);
            return false;
        }
    }

    /**
     * Get all captured screenshots for batch processing.
     */
    getCaptures(): CapturedPost[] {
        return this.captures;
    }

    /**
     * Get capture count.
     */
    getCaptureCount(): number {
        return this.captures.length;
    }

    /**
     * Get source breakdown for logging.
     */
    getSourceBreakdown(): Record<CaptureSource, number> {
        const breakdown: Record<CaptureSource, number> = {
            feed: 0,
            story: 0,
            profile: 0,
            carousel: 0
        };

        for (const capture of this.captures) {
            breakdown[capture.source]++;
        }

        return breakdown;
    }

    /**
     * Get approximate memory usage in bytes.
     */
    getMemoryUsage(): number {
        const captureBytes = this.captures.reduce((total, c) => total + c.screenshot.length, 0);
        // VIDEO RECORDING DISABLED
        // const videoBytes = this.capturedVideos.reduce((total, v) => v.frames.reduce((t, f) => t + f.length, 0) + total, 0);
        return captureBytes;
    }

    /**
     * Clear all captures and videos (call after processing to free memory).
     */
    clear(): void {
        this.captures = [];
        // this.capturedVideos = [];  // VIDEO RECORDING DISABLED
        this.lastScrollPosition = 0;
        this.capturedHashes.clear();
        this.capturedPositions.clear();
        this.lastCaptureSource = '';
        console.log('📸 Collector cleared');
    }

    // VIDEO RECORDING DISABLED — storeVideoRecording(), getVideos(), getVideoCount() commented out
    // storeVideoRecording(...): number { ... }
    getVideos(): any[] { return []; }
    getVideoCount(): number { return 0; }

    /**
     * Get the current count of captured photos/screenshots.
     * Used by LLM to track capture progress.
     */
    getPhotoCount(): number {
        return this.captures.length;
    }

    /**
     * Compute a perceptual hash (average hash) of a screenshot.
     * Resilient to minor differences (scroll jitter, compression artifacts).
     * Returns a 64-bit hex string (16 hex chars).
     */
    async computePerceptualHash(screenshot: Buffer): Promise<string> {
        try {
            const image = await Jimp.read(screenshot);
            image.resize({ w: 8, h: 8 });
            image.greyscale();

            const pixels: number[] = [];
            for (let y = 0; y < 8; y++) {
                for (let x = 0; x < 8; x++) {
                    const color = image.getPixelColor(x, y);
                    // R channel from 0xRRGGBBAA (after greyscale R=G=B)
                    pixels.push((color >> 24) & 0xFF);
                }
            }
            const mean = pixels.reduce((a, b) => a + b, 0) / pixels.length;

            let hex = '';
            for (let i = 0; i < 64; i += 4) {
                const nibble = [0,1,2,3].map(j => pixels[i+j] > mean ? '1' : '0').join('');
                hex += parseInt(nibble, 2).toString(16);
            }
            return hex;
        } catch {
            // Fallback to MD5 if perceptual hash fails
            return createHash('md5').update(screenshot).digest('hex');
        }
    }

    /**
     * Hamming distance between two hex hash strings (count differing bits).
     */
    private hammingDistance(hash1: string, hash2: string): number {
        // Different lengths = different hash types (MD5 fallback vs phash) — treat as unique
        if (hash1.length !== hash2.length) return 64;
        let distance = 0;
        for (let i = 0; i < hash1.length; i++) {
            let xor = parseInt(hash1[i], 16) ^ parseInt(hash2[i], 16);
            while (xor) { distance += xor & 1; xor >>= 1; }
        }
        return distance;
    }

    /**
     * Check if a hash is perceptually similar to any previously captured hash.
     * Default threshold 5 (~92% similar). Stories use 3 (dark background dominates hash).
     */
    private isSimilarToExisting(hash: string, threshold: number = 5): boolean {
        for (const existing of this.capturedHashes) {
            if (this.hammingDistance(hash, existing) <= threshold) return true;
        }
        return false;
    }

    /**
     * Get current scroll Y position via CDP (no page.evaluate needed).
     */
    async getScrollPosition(): Promise<number> {
        try {
            // Use CDP to get scroll position (more bot-proof than page.evaluate)
            const client = await this.page.context().newCDPSession(this.page);
            const result = await client.send('Runtime.evaluate', {
                expression: 'window.scrollY',
                returnByValue: true
            });
            await client.detach();
            return result.result.value as number;
        } catch {
            // Fallback to page.evaluate if CDP fails
            return await this.page.evaluate(() => window.scrollY);
        }
    }

    /**
     * Append a line to the session log buffer.
     * Lines are timestamped relative to session start.
     */
    appendLog(line: string): void {
        const elapsed = ((Date.now() - this.sessionStartTime) / 1000).toFixed(1);
        this.logBuffer.push(`[${elapsed}s] ${line}`);
    }

    /**
     * Append a raw line (no timestamp prefix) to the session log buffer.
     * Used for headers, separators, and pre-formatted content.
     */
    appendLogRaw(line: string): void {
        this.logBuffer.push(line);
    }

    /**
     * Flush the session log buffer to a markdown file alongside screenshots.
     * Called at session end. Only writes if outputDir is configured.
     */
    flushSessionLog(): void {
        if (!this.outputDir || this.logBuffer.length === 0) return;

        const filepath = path.join(this.outputDir, 'session_log.md');
        const content = this.logBuffer.join('\n') + '\n';
        fs.writeFileSync(filepath, content, 'utf-8');
        console.log(`📝 Session log saved: ${filepath}`);
    }

    /**
     * Log summary of captured content.
     */
    logSummary(): void {
        const breakdown = this.getSourceBreakdown();
        const memoryMB = (this.getMemoryUsage() / (1024 * 1024)).toFixed(2);

        console.log(`\n📸 Screenshot Collection Summary:`);
        console.log(`   Total: ${this.captures.length} captures`);
        console.log(`   Feed: ${breakdown.feed}, Stories: ${breakdown.story}`);
        console.log(`   Memory: ${memoryMB}MB`);
        console.log('');
    }
}
