/**
 * BaseVisionAgent - Abstract base for phase-specific browsing agents.
 *
 * Shared infrastructure: screenshot capture, LLM calling, action execution,
 * debug screenshot saving, JSON parsing, raw screenshot dumping, tab management.
 *
 * Subclasses provide: system prompt, max duration, raw directory, model selection,
 * reference image configuration, and per-turn user prompt customization.
 */

import { Page } from 'playwright';
import { Jimp } from 'jimp';
import fs from 'fs';
import path from 'path';
import { GhostMouse } from './GhostMouse.js';
import { HumanScroll } from './HumanScroll.js';
import { ScreenshotCollector } from './ScreenshotCollector.js';
import { isOnline, isNetworkError, isCreditsDepletedError, OFFLINE_ERROR, CREDITS_DEPLETED_ERROR } from './NetworkMonitor.js';
import { labelElements, type LabeledElement } from '../../utils/elementLabeler.js';
import capabilitiesPrompt from '../prompts/capabilities.md';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** LLM response schema — the complete output format. */
export interface VisionAction {
    thinking: string;
    action: 'click' | 'scroll' | 'type' | 'press' | 'hover' | 'wait' | 'done' | 'newtab' | 'closetab' | 'goback';
    element?: number;
    direction?: 'up' | 'down';
    text?: string;
    key?: string;
    seconds?: number;
    memory?: string;
    result?: string;
    // Intent-driven action fields
    intent?: string;
    expected_state?: string;
    if_wrong?: string;
    // Self-enriching element legend
    element_notes?: Record<string, string>;
    // Persistent lessons
    lesson?: string;
}

export interface ActionHistoryEntry {
    action: string;
    result: string;
}

export interface BaseAgentConfig {
    apiKey: string;
    maxDurationMs: number;
    debugMode?: boolean;
    sessionMemoryDigest?: string;
    rawDir?: string;
}

export interface AgentResult {
    rawScreenshotCount: number;
    decisionCount: number;
    actionHistory: ActionHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCREENSHOT_WIDTH = 1280;

// ---------------------------------------------------------------------------
// Element Fingerprint — used for self-enriching element legend
// ---------------------------------------------------------------------------

function elementFingerprint(el: LabeledElement): string {
    const href = el.href || '';
    const hrefPattern = href
        .replace(/\/stories\/[^/]+\/?.*/, '/stories/')
        .replace(/\/p\/[^/]+\/?.*/, '/p/')
        .replace(/\/reel\/[^/]+\/?.*/, '/reel/')
        .replace(/\/[^/]+\/?$/, '/');

    return `${el.tag}|${el.ariaLabel}|${hrefPattern}`;
}

// ---------------------------------------------------------------------------
// BaseVisionAgent
// ---------------------------------------------------------------------------

export abstract class BaseVisionAgent {
    protected page: Page;
    protected ghost: GhostMouse;
    protected scroll: HumanScroll;
    protected collector: ScreenshotCollector;
    protected config: BaseAgentConfig;

    // Screenshot dimensions
    protected screenshotWidth: number = SCREENSHOT_WIDTH;
    protected screenshotHeight: number = 0;

    // Viewport dimensions
    protected viewportWidth: number = 0;
    protected viewportHeight: number = 0;

    // LLM state
    protected lastMemory: string = '';
    protected actionHistory: ActionHistoryEntry[] = [];
    protected decisionCount: number = 0;
    protected lastTokenUsage: { promptTokens: number; completionTokens: number } | null = null;

    // Session state
    protected startTime: number = 0;

    // Raw screenshot dump
    protected rawDir: string = '';
    protected rawCount: number = 0;

    // Reference images
    protected referenceImages: Array<{ label: string; base64: string }> | null = null;
    protected referenceImagesSent: boolean = false;

    // Tab management
    protected originalPage: Page | null = null;

    // Current turn's labeled elements
    protected currentElements: Map<number, LabeledElement> = new Map();

    // Previous action tracking
    protected lastAction: VisionAction | null = null;

    // Intent-driven action state
    protected lastIntent: string = '';
    protected lastExpectedState: string = '';
    protected lastRecoveryPlan: string = '';

    // Self-enriching element legend
    protected elementKnowledge: Map<string, string> = new Map();

    // Persistent learned lessons
    protected learnedLessons: string[] = [];

    // Raw screenshot for debug saving (kept across LLM call)
    protected lastRawScreenshot: Buffer | null = null;

    // Raw screenshot gating — only save when viewing content (post modal, carousel slide)
    protected lastActionWasContentCapture: boolean = false;

    // External stop signal
    protected stopped: boolean = false;
    protected abortController: AbortController = new AbortController();

    constructor(
        page: Page,
        ghost: GhostMouse,
        scroll: HumanScroll,
        collector: ScreenshotCollector,
        config: BaseAgentConfig
    ) {
        this.page = page;
        this.ghost = ghost;
        this.scroll = scroll;
        this.collector = collector;
        this.config = config;
    }

    // -----------------------------------------------------------------------
    // Abstract methods — subclasses must implement
    // -----------------------------------------------------------------------

    /** Return the phase-specific instruction prompt (appended to capabilities). */
    protected abstract getInstructionPrompt(): string;

    /** Return the model ID to use for LLM calls. */
    protected abstract getModel(): string;

    /** Return max_tokens for LLM responses. */
    protected abstract getMaxTokens(): number;

    /** Return the directory name for reference images (e.g. 'Stories', 'Posts'). */
    protected abstract getReferenceImageFolder(): string | null;

    /** Return the agent name for logging. */
    protected abstract getAgentName(): string;

    /** Whether this agent needs element labeling (DOM detection + badge drawing). */
    protected abstract shouldLabelElements(): boolean;

    /** Return a structured workflow summary for the assistant response after reference images. */
    protected getWorkflowSummary(): string | null {
        return null;
    }

    // -----------------------------------------------------------------------
    // Public API
    // -----------------------------------------------------------------------

    /** Stop the agent externally (e.g. Cmd+Shift+K). */
    stop(): void {
        this.stopped = true;
        this.abortController.abort();
        console.log(`🛑 ${this.getAgentName()}: external stop signal received`);
        this.collector.appendLog(`🛑 ${this.getAgentName()}: external stop signal received`);
    }

    async run(): Promise<AgentResult> {
        this.startTime = Date.now();
        const vp = this.page.viewportSize();
        this.viewportWidth = vp?.width || 1080;
        this.viewportHeight = vp?.height || 1920;

        const model = this.getModel();
        console.log(`\n👁️  ${this.getAgentName()} starting (viewport: ${this.viewportWidth}x${this.viewportHeight}, model: ${model})`);
        this.collector.appendLog(`👁️ ${this.getAgentName()} starting (viewport: ${this.viewportWidth}x${this.viewportHeight}, model: ${model})`);

        // Set up raw screenshot directory
        if (this.config.rawDir) {
            this.rawDir = this.config.rawDir;
            if (!fs.existsSync(this.rawDir)) fs.mkdirSync(this.rawDir, { recursive: true });
        } else {
            const sessionOutputDir = this.collector.getOutputDir();
            if (sessionOutputDir) {
                this.rawDir = path.join(sessionOutputDir, 'raw');
                if (!fs.existsSync(this.rawDir)) fs.mkdirSync(this.rawDir, { recursive: true });
            }
        }

        // Load reference images
        this.loadReferenceImages();

        // === FIRST TURN: observe initial state, get first decision ===
        let decision: VisionAction | null = null;
        while (!decision) {
            if (this.stopped) break;
            const elapsed = Date.now() - this.startTime;
            if (this.config.maxDurationMs - elapsed <= 0) break;
            decision = await this.captureAndDecide(this.config.maxDurationMs - elapsed);
            if (!decision) await this.delay(500); // screenshot failed, retry
        }

        if (!decision || decision.action === 'done') {
            // Edge case: LLM said done on first turn or we timed out/stopped
            if (decision) {
                console.log(`✅ ${this.getAgentName()}: LLM ended session — ${decision.thinking}`);
                this.collector.appendLog(`✅ ${this.getAgentName()}: LLM ended session — ${decision.thinking}`);
            }
            // fall through to cleanup
        } else {
            // === MAIN LOOP: execute decision, observe result, get next ===
            while (true) {
                if (this.stopped) {
                    console.log(`🛑 ${this.getAgentName()}: stopped by user`);
                    this.collector.appendLog(`🛑 ${this.getAgentName()}: stopped by user (Cmd+Shift+K)`);
                    break;
                }

                // Persist state from current decision
                if (decision.memory) this.lastMemory = decision.memory;
                this.lastIntent = decision.intent || '';
                this.lastExpectedState = decision.expected_state || '';
                this.lastRecoveryPlan = decision.if_wrong || '';
                if (decision.element_notes) {
                    for (const [idStr, description] of Object.entries(decision.element_notes)) {
                        const id = parseInt(idStr, 10);
                        const el = this.currentElements.get(id);
                        if (el) this.elementKnowledge.set(elementFingerprint(el), description);
                    }
                }
                if (decision.lesson) {
                    this.learnedLessons.push(decision.lesson);
                    if (this.learnedLessons.length > 10) this.learnedLessons.shift();
                }

                // 1. EXECUTE the action
                const result = await this.executeAction(decision);
                console.log(`     → ${result}`);
                this.lastAction = decision;

                // Record history + log
                this.actionHistory.push({ action: this.formatAction(decision), result });
                const tokenStr = this.lastTokenUsage
                    ? ` | ${this.lastTokenUsage.promptTokens}+${this.lastTokenUsage.completionTokens} tokens`
                    : '';
                this.collector.appendLog(`[${this.decisionCount}] ${this.formatAction(decision)}${tokenStr}`);
                this.collector.appendLog(`  💭 ${decision.thinking}`);
                this.collector.appendLog(`  → ${result}`);
                if (decision.memory) this.collector.appendLog(`  📝 Memory: ${decision.memory}`);

                // Check time
                const elapsed = Date.now() - this.startTime;
                const remaining = this.config.maxDurationMs - elapsed;
                if (remaining <= 0) {
                    console.log(`⏱️  ${this.getAgentName()}: time limit reached`);
                    this.collector.appendLog(`⏱️ ${this.getAgentName()}: time limit reached`);
                    break;
                }

                // 2. SETTLE — wait for page to stabilize after action
                await this.settleAfterAction(decision);

                // 3. SCREENSHOT — one screenshot, dual purpose
                const rawScreenshot = await this.captureScreenshot();
                if (!rawScreenshot) {
                    await this.delay(500);
                    continue;
                }

                // 3a. Save raw for analysis/filtering (only after content actions)
                if (this.lastActionWasContentCapture) {
                    this.saveRawScreenshot(rawScreenshot);
                }
                this.lastRawScreenshot = rawScreenshot;

                // 3b. Label the SAME screenshot for LLM
                let screenshot: Buffer;
                if (this.shouldLabelElements()) {
                    const labeled = await labelElements(
                        this.page, rawScreenshot,
                        this.screenshotWidth, this.screenshotHeight,
                        this.viewportWidth, this.viewportHeight
                    );
                    screenshot = labeled.buffer;
                    this.currentElements = labeled.elements;
                    console.log(`  🏷️ Labeled ${labeled.elements.size} interactive elements`);
                } else {
                    screenshot = rawScreenshot;
                    this.currentElements = new Map();
                }

                // 4. DECIDE — send labeled screenshot to LLM
                const nextDecision = await this.callLLM(screenshot, remaining);
                this.decisionCount++;
                console.log(`  🧭 [${this.decisionCount}] action=${nextDecision.action} | ${nextDecision.thinking.slice(0, 80)}`);

                if (['click', 'hover', 'newtab'].includes(nextDecision.action) && nextDecision.element !== undefined) {
                    const el = this.currentElements.get(nextDecision.element);
                    const desc = el ? `"${el.text || el.ariaLabel || el.tag}"` : 'unknown';
                    const coordLog = `[${this.decisionCount}] ${nextDecision.action}([${nextDecision.element}] ${desc}) — ${nextDecision.thinking}`;
                    console.log(`  📍 ${coordLog}`);
                    this.collector.appendLog(`📍 ${coordLog}`);
                }

                await this.saveDebugScreenshot(screenshot, nextDecision);

                // Check if done
                if (nextDecision.action === 'done') {
                    console.log(`✅ ${this.getAgentName()}: LLM ended session — ${nextDecision.thinking}`);
                    this.collector.appendLog(`✅ ${this.getAgentName()}: LLM ended session — ${nextDecision.thinking}`);
                    break;
                }

                decision = nextDecision;
            }
        }

        // Signal to the filter agent that this phase is complete
        if (this.rawDir) {
            fs.writeFileSync(path.join(this.rawDir, 'done.marker'), JSON.stringify({
                totalScreenshots: this.rawCount,
                totalDecisions: this.decisionCount,
                agent: this.getAgentName(),
                timestamp: Date.now()
            }));
        }

        console.log(`\n👁️  ${this.getAgentName()} finished: ${this.rawCount} raw screenshots, ${this.decisionCount} decisions\n`);
        this.collector.appendLog(`👁️ ${this.getAgentName()} finished: ${this.rawCount} raw screenshots, ${this.decisionCount} decisions`);

        return {
            rawScreenshotCount: this.rawCount,
            decisionCount: this.decisionCount,
            actionHistory: [...this.actionHistory]
        };
    }

    // -----------------------------------------------------------------------
    // Screenshot + LLM decision helper
    // -----------------------------------------------------------------------

    private async captureAndDecide(remainingMs: number): Promise<VisionAction | null> {
        const rawScreenshot = await this.captureScreenshot();
        if (!rawScreenshot) return null;

        this.saveRawScreenshot(rawScreenshot);
        this.lastRawScreenshot = rawScreenshot;

        let screenshot: Buffer;
        if (this.shouldLabelElements()) {
            const labeled = await labelElements(
                this.page, rawScreenshot,
                this.screenshotWidth, this.screenshotHeight,
                this.viewportWidth, this.viewportHeight
            );
            screenshot = labeled.buffer;
            this.currentElements = labeled.elements;
            console.log(`  🏷️ Labeled ${labeled.elements.size} interactive elements`);
        } else {
            screenshot = rawScreenshot;
            this.currentElements = new Map();
        }

        const decision = await this.callLLM(screenshot, remainingMs);
        this.decisionCount++;
        console.log(`  🧭 [${this.decisionCount}] action=${decision.action} | ${decision.thinking.slice(0, 80)}`);

        // Log element-based actions
        if (['click', 'hover', 'newtab'].includes(decision.action) && decision.element !== undefined) {
            const el = this.currentElements.get(decision.element);
            const desc = el ? `"${el.text || el.ariaLabel || el.tag}"` : 'unknown';
            const coordLog = `[${this.decisionCount}] ${decision.action}([${decision.element}] ${desc}) — ${decision.thinking}`;
            console.log(`  📍 ${coordLog}`);
            this.collector.appendLog(`📍 ${coordLog}`);
        }

        await this.saveDebugScreenshot(screenshot, decision);
        return decision;
    }

    // -----------------------------------------------------------------------
    // Screenshot Capture & Resize
    // -----------------------------------------------------------------------

    protected async captureScreenshot(): Promise<Buffer | null> {
        try {
            const raw = await this.page.screenshot({ type: 'jpeg', quality: 80, fullPage: false });
            const image = await Jimp.read(Buffer.from(raw));
            const origW = image.width;
            const origH = image.height;
            if (origW > SCREENSHOT_WIDTH) {
                image.resize({ w: SCREENSHOT_WIDTH });
            }
            this.screenshotWidth = image.width;
            this.screenshotHeight = image.height;
            const buffer = await image.getBuffer('image/jpeg', { quality: 80 });
            const sizeKB = Math.round(buffer.length / 1024);
            console.log(`  📸 Screenshot: ${origW}x${origH} → ${this.screenshotWidth}x${this.screenshotHeight} (${sizeKB}KB)`);
            this.collector.appendLog(`📸 ${origW}x${origH} → ${this.screenshotWidth}x${this.screenshotHeight} (${sizeKB}KB)`);
            return buffer;
        } catch (err) {
            console.warn('  ⚠️ Screenshot failed:', err);
            this.collector.appendLog(`⚠️ Screenshot failed: ${err}`);
            return null;
        }
    }

    // -----------------------------------------------------------------------
    // Raw Screenshot Dump
    // -----------------------------------------------------------------------

    protected saveRawScreenshot(buffer: Buffer): void {
        if (!this.rawDir) return;
        this.rawCount++;
        const padded = this.rawCount.toString().padStart(3, '0');
        fs.writeFileSync(path.join(this.rawDir, `${padded}.jpg`), buffer);
        fs.writeFileSync(path.join(this.rawDir, `${padded}.json`), JSON.stringify({
            turn: this.decisionCount,
            phase: this.getAgentName(),
            timestamp: Date.now()
        }));
    }

    // -----------------------------------------------------------------------
    // Action Execution
    // -----------------------------------------------------------------------

    protected async executeAction(decision: VisionAction): Promise<string> {
        switch (decision.action) {
            case 'click': return this.executeClick(decision);
            case 'scroll': return this.executeScroll(decision);
            case 'type': return this.executeType(decision);
            case 'press': return this.executePress(decision);
            case 'hover': return this.executeHover(decision);
            case 'wait': return this.executeWait(decision);
            case 'newtab': return this.executeNewtab(decision);
            case 'closetab': return this.executeClosetab();
            case 'goback': return this.executeGoback();
            default: return `unknown action: ${decision.action}`;
        }
    }

    /**
     * Smart post-action delay based on what just happened.
     * Post navigations and carousel advances need more time than scrolls/hovers.
     */
    protected async settleAfterAction(decision: VisionAction): Promise<void> {
        if (decision.action === 'click' && decision.element !== undefined) {
            const el = this.currentElements.get(decision.element);
            if (el) {
                // Post click: href contains /p/ or /reel/ → full page navigation
                if (/\/p\/|\/reel\//.test(el.href)) {
                    console.log('  ⏳ Post navigation detected — waiting for page load');
                    this.collector.appendLog('⏳ Waiting for post page to load');
                    this.lastActionWasContentCapture = true;
                    try {
                        await this.page.waitForLoadState('domcontentloaded', { timeout: 5000 });
                    } catch {
                        // Timeout — fall through to flat delay
                    }
                    await this.delay(800);
                    return;
                }

                // Carousel advance: button labeled Next/Previous/Go Forward/Go Back
                const label = (el.ariaLabel || el.text || '').toLowerCase();
                if ((el.tag === 'button' || el.role === 'button') &&
                    /next|previous|go forward|go back|chevron/.test(label)) {
                    console.log('  ⏳ Carousel advance detected — waiting for slide');
                    this.collector.appendLog('⏳ Waiting for carousel slide to load');
                    this.lastActionWasContentCapture = true;
                    await this.delay(1000);
                    return;
                }
            }
        }

        // Default settle for everything else
        this.lastActionWasContentCapture = false;
        await this.delay(300);
    }

    private async executeClick(d: VisionAction): Promise<string> {
        if (d.element === undefined) return 'missing element number';
        const el = this.currentElements.get(d.element);
        if (!el) return `element [${d.element}] not found — pick a visible labeled element`;
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;
        console.log(`  🖱️ click: element [${d.element}] "${el.text || el.ariaLabel}" → viewport(${Math.round(cx)},${Math.round(cy)}) | url=${this.page.url()}`);
        this.collector.appendLog(`🖱️ click: element [${d.element}] "${el.text || el.ariaLabel}" → viewport(${Math.round(cx)},${Math.round(cy)}) | url=${this.page.url()}`);
        await this.ghost.clickPoint(cx, cy);
        return `clicked [${d.element}] "${el.text || el.ariaLabel || el.tag}"`;
    }

    private async executeScroll(d: VisionAction): Promise<string> {
        const direction = d.direction || 'down';
        const baseDistance = direction === 'up'
            ? -Math.round(this.viewportHeight * 0.4)
            : Math.round(this.viewportHeight * 0.4);

        // Position mouse in the feed area so wheel events land on scrollable content
        const feedX = this.viewportWidth * (0.35 + Math.random() * 0.30);
        const feedY = this.viewportHeight * (0.25 + Math.random() * 0.50);
        await this.page.mouse.move(feedX, feedY);

        console.log(`  📜 scroll: direction=${direction}, baseDistance=${baseDistance}px`);
        this.collector.appendLog(`📜 scroll: direction=${direction}, baseDistance=${baseDistance}px`);
        const result = await this.scroll.scrollWithIntent({ baseDistance });
        if (result.scrollFailed) {
            console.log(`  📜 scroll failed`);
            this.collector.appendLog(`📜 scroll failed`);
            return 'scroll failed';
        }
        console.log(`  📜 scrolled ${direction} ${Math.abs(result.actualDelta)}px`);
        this.collector.appendLog(`📜 scrolled ${direction} ${Math.abs(result.actualDelta)}px`);
        return `scrolled ${direction} ${Math.abs(result.actualDelta)}px`;
    }

    private async executeType(d: VisionAction): Promise<string> {
        if (!d.text) return 'no text provided';

        const context = await this.getFocusedInputContext();
        console.log(`  ⌨️ type: text="${d.text.slice(0, 40)}", inputContext=${context}`);
        this.collector.appendLog(`⌨️ type: text="${d.text.slice(0, 40)}", inputContext=${context}`);
        if (context === 'comment' || context === 'message') {
            console.warn(`  🚫 BLOCKED: typing in ${context} context`);
            this.collector.appendLog(`🚫 BLOCKED: typing in ${context} context`);
            return `BLOCKED: cannot type in ${context} field`;
        }

        await this.page.keyboard.type(d.text);
        console.log(`  ⌨️ typed "${d.text.slice(0, 40)}"`);
        this.collector.appendLog(`⌨️ typed "${d.text.slice(0, 40)}"`);
        return `typed "${d.text.slice(0, 30)}"`;
    }

    private async executePress(d: VisionAction): Promise<string> {
        if (!d.key) return 'no key provided';
        console.log(`  🔑 press: key=${d.key}`);
        this.collector.appendLog(`🔑 press: key=${d.key}`);
        await this.page.keyboard.press(d.key);
        return `pressed ${d.key}`;
    }

    private async executeHover(d: VisionAction): Promise<string> {
        if (d.element === undefined) return 'missing element number';
        const el = this.currentElements.get(d.element);
        if (!el) return `element [${d.element}] not found — pick a visible labeled element`;
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;
        console.log(`  👆 hover: element [${d.element}] "${el.text || el.ariaLabel}" → viewport(${Math.round(cx)},${Math.round(cy)})`);
        this.collector.appendLog(`👆 hover: element [${d.element}] "${el.text || el.ariaLabel}" → viewport(${Math.round(cx)},${Math.round(cy)})`);
        await this.ghost.moveTo({ x: cx, y: cy });
        return `hovered [${d.element}] "${el.text || el.ariaLabel || el.tag}"`;
    }

    private async executeWait(d: VisionAction): Promise<string> {
        const seconds = Math.max(1, Math.min(5, d.seconds || 2));
        console.log(`  ⏳ wait: ${seconds}s`);
        this.collector.appendLog(`⏳ wait: ${seconds}s`);
        await this.delay(seconds * 1000);
        return `waited ${seconds}s`;
    }

    // -----------------------------------------------------------------------
    // Tab Management
    // -----------------------------------------------------------------------

    private async executeNewtab(d: VisionAction): Promise<string> {
        if (d.element === undefined) return 'missing element number';
        const el = this.currentElements.get(d.element);
        if (!el) return `element [${d.element}] not found — pick a visible labeled element`;

        const context = this.page.context();
        const cx = el.x + el.width / 2;
        const cy = el.y + el.height / 2;

        console.log(`  🔗 newtab: element [${d.element}] "${el.text || el.ariaLabel}" → viewport(${Math.round(cx)},${Math.round(cy)}) | from=${this.page.url()}`);
        this.collector.appendLog(`🔗 newtab: element [${d.element}] "${el.text || el.ariaLabel}" → viewport(${Math.round(cx)},${Math.round(cy)}) | from=${this.page.url()}`);

        if (!this.originalPage) {
            this.originalPage = this.page;
        }

        try {
            await this.ghost.moveTo({ x: cx, y: cy });
            const newPagePromise = context.waitForEvent('page', { timeout: 5000 });
            await this.page.mouse.click(cx, cy, { button: 'middle' });

            const newPage = await newPagePromise;
            await newPage.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});

            this.switchToPage(newPage);
            console.log(`  🔗 newtab opened → ${newPage.url()}`);
            this.collector.appendLog(`🔗 newtab opened → ${newPage.url()}`);
            return `opened new tab → ${newPage.url()}. You are now in a NEW TAB. Use closetab when done to return.`;
        } catch {
            console.log(`  🔗 newtab failed — target not a link`);
            this.collector.appendLog(`🔗 newtab failed — target not a link`);
            return 'newtab failed — target may not be a link. Try click() instead.';
        }
    }

    private async executeGoback(): Promise<string> {
        const beforeUrl = this.page.url();
        console.log(`  ↩️ goback: from ${beforeUrl}`);
        this.collector.appendLog(`↩️ goback: from ${beforeUrl}`);
        await this.page.goBack({ waitUntil: 'domcontentloaded', timeout: 5000 }).catch(() => {});
        await this.delay(500);
        const afterUrl = this.page.url();
        console.log(`  ↩️ goback: now at ${afterUrl}`);
        this.collector.appendLog(`↩️ goback: now at ${afterUrl}`);
        return `navigated back from ${beforeUrl} → ${afterUrl}`;
    }

    private async executeClosetab(): Promise<string> {
        if (!this.originalPage) {
            return 'no tab to close — already on the main tab';
        }

        if (this.page === this.originalPage) {
            this.originalPage = null;
            return 'already on main tab';
        }

        const closingUrl = this.page.url();
        try {
            await this.page.close();
        } catch {
            // Page may already be closed
        }

        this.switchToPage(this.originalPage);
        this.originalPage = null;
        return `closed tab (was: ${closingUrl}), back to ${this.page.url()}`;
    }

    private switchToPage(page: Page): void {
        this.page = page;
        this.ghost.setPage(page);
        this.scroll.setPage(page);
        this.collector.setPage(page);

        const vp = page.viewportSize();
        if (vp) {
            this.viewportWidth = vp.width;
            this.viewportHeight = vp.height;
        }
    }

    // -----------------------------------------------------------------------
    // Safety Guardrail
    // -----------------------------------------------------------------------

    private async getFocusedInputContext(): Promise<'search' | 'comment' | 'message' | 'unknown'> {
        try {
            return await this.page.evaluate(() => {
                const el = document.activeElement;
                if (!el) return 'unknown';

                let node: Element | null = el;
                while (node) {
                    const label = (node.getAttribute('aria-label') || '').toLowerCase();
                    const placeholder = (node.getAttribute('placeholder') || '').toLowerCase();
                    const role = (node.getAttribute('role') || '').toLowerCase();

                    if (label.includes('search') || placeholder.includes('search') || role === 'search') return 'search';
                    if (label.includes('comment') || label.includes('reply') || placeholder.includes('comment')) return 'comment';
                    if (label.includes('message') || label.includes('direct') || label.includes('chat') || placeholder.includes('message')) return 'message';

                    node = node.parentElement;
                }
                return 'unknown';
            }) as 'search' | 'comment' | 'message' | 'unknown';
        } catch {
            return 'unknown';
        }
    }

    // -----------------------------------------------------------------------
    // LLM Integration
    // -----------------------------------------------------------------------

    protected async callLLM(screenshot: Buffer, remainingMs: number): Promise<VisionAction> {
        const systemPrompt = this.getSystemPrompt();
        const userPrompt = this.buildUserPrompt(remainingMs);
        const visionDetail = process.env.KOWALSKI_VISION_DETAIL || 'high';

        const messages: Array<Record<string, unknown>> = [];

        // Inject reference images on first turn
        if (!this.referenceImagesSent && this.referenceImages && this.referenceImages.length > 0) {
            const refContent: Array<Record<string, unknown>> = [];

            // Include phase-specific reference images
            for (const ref of this.referenceImages) {
                refContent.push({
                    type: 'image',
                    source: this.dataUrlToAnthropicSource(ref.base64)
                });
                refContent.push({
                    type: 'text',
                    text: `[Step: ${ref.label}]`
                });
            }

            if (refContent.length > 0) {
                const folder = this.getReferenceImageFolder() || 'this phase';
                refContent.push({
                    type: 'text',
                    text: `These are step-by-step instructions for how to handle ${folder.toLowerCase()} on Instagram. The images are numbered — follow them in sequence. Read the annotations in each image carefully.`
                });
                messages.push({ role: 'user', content: refContent });
                const summary = this.getWorkflowSummary();
                messages.push({
                    role: 'assistant',
                    content: summary || `Understood. I'll follow the ${folder.toLowerCase()} workflow steps shown above.`
                });
                console.log(`  📎 Injected reference images (${this.referenceImages.length} images)`);
                this.collector.appendLog(`📎 Injected reference images (${this.referenceImages.length} images)`);
            }
            this.referenceImagesSent = true;
        }

        // Current turn: live screenshot + context
        messages.push({
            role: 'user',
            content: [
                {
                    type: 'image',
                    source: {
                        type: 'base64',
                        media_type: 'image/jpeg',
                        data: screenshot.toString('base64')
                    }
                },
                { type: 'text', text: userPrompt }
            ]
        });

        const requestBody: Record<string, unknown> = {
            model: this.getModel(),
            system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
            messages,
            max_tokens: this.getMaxTokens(),
        };

        // Attempt LLM call with exponential backoff
        const maxRetries = 4;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            if (this.stopped) break;
            try {
                // Bound each request at 20s. Undici's default headers timeout is
                // 5 minutes — way too long when WiFi drops mid-request. The
                // composed signal still honors run-level stop from this.abortController.
                const perRequestTimeout = AbortSignal.timeout(20_000);
                const response = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': this.config.apiKey,
                        'anthropic-version': '2023-06-01',
                        'anthropic-beta': 'prompt-caching-2024-07-31'
                    },
                    body: JSON.stringify(requestBody),
                    signal: AbortSignal.any([this.abortController.signal, perRequestTimeout])
                });

                if (!response.ok) {
                    const errText = await response.text();
                    console.warn(`  ⚠️ LLM API error (${response.status}): ${errText.slice(0, 200)}`);
                    this.collector.appendLog(`  ⚠️ LLM API error (${response.status}): ${errText.slice(0, 200)}`);
                    // Credit exhaustion is unrecoverable — fail the run now so
                    // the UI can surface the "refill API balance" screen.
                    if (isCreditsDepletedError(response.status, errText)) {
                        throw new Error(CREDITS_DEPLETED_ERROR);
                    }
                    if ((response.status === 529 || response.status === 429) && attempt < maxRetries - 1) {
                        const baseDelay = response.status === 429 ? 10000 : 5000;
                        const backoff = Math.min(baseDelay * Math.pow(2, attempt), 60000);
                        const jitter = backoff * 0.25 * (Math.random() * 2 - 1);
                        const delay = Math.round(backoff + jitter);
                        console.log(`  ⏳ Retrying (${attempt + 1}/${maxRetries - 1}) after ${(delay / 1000).toFixed(1)}s backoff...`);
                        this.collector.appendLog(`  ⏳ Retrying (${attempt + 1}/${maxRetries - 1}) after ${(delay / 1000).toFixed(1)}s backoff...`);
                        await this.delay(delay);
                        continue;
                    }
                    break;
                }

                const data = await response.json() as Record<string, unknown>;

                const usage = data.usage as { input_tokens?: number; output_tokens?: number; cache_creation_input_tokens?: number; cache_read_input_tokens?: number } | undefined;
                if (usage) {
                    this.lastTokenUsage = {
                        promptTokens: usage.input_tokens || 0,
                        completionTokens: usage.output_tokens || 0
                    };
                    const cacheInfo = usage.cache_read_input_tokens
                        ? ` (cached: ${usage.cache_read_input_tokens})`
                        : '';
                    console.log(`  🧠 Tokens: ${usage.input_tokens} in${cacheInfo}, ${usage.output_tokens} out (vision:${visionDetail})`);
                    this.collector.appendLog(`  🧠 Tokens: ${usage.input_tokens} in${cacheInfo}, ${usage.output_tokens} out (vision:${visionDetail})`);
                }

                const contentBlocks = data.content as Array<{ type: string; text?: string; thinking?: string }> | undefined;
                const textBlock = contentBlocks?.find(b => b.type === 'text');
                const content = textBlock?.text;
                if (!content || typeof content !== 'string') {
                    console.warn(`  ⚠️ Empty LLM response (attempt ${attempt + 1}/${maxRetries})`);
                    this.collector.appendLog(`  ⚠️ Empty LLM response (attempt ${attempt + 1}/${maxRetries})`);
                    if (attempt < maxRetries - 1) { await this.delay(500); continue; }
                    break;
                }

                return this.parseJsonResponse(content);

            } catch (err) {
                if (this.stopped) break;

                // Credit exhaustion thrown from the !response.ok branch above —
                // re-throw so it propagates past Kowalski to RunManager.
                if (err instanceof Error && err.message === CREDITS_DEPLETED_ERROR) {
                    throw err;
                }

                console.warn(`  ⚠️ LLM call/parse error (attempt ${attempt + 1}/${maxRetries}):`, err);
                this.collector.appendLog(`  ⚠️ LLM call/parse error (attempt ${attempt + 1}/${maxRetries}): ${err}`);

                // If this looks like a network failure, confirm with a fast probe
                // and bail out of the whole run rather than burning 4 retries on
                // a dead connection. The throw bubbles up through the agent's
                // run() to Kowalski → RunManager, which emits kind: 'offline'.
                if (isNetworkError(err) && !(await isOnline())) {
                    throw new Error(OFFLINE_ERROR);
                }

                if (attempt < maxRetries - 1) { await this.delay(500); continue; }
            }
        }

        // Fallback
        console.warn('  ⚠️ LLM failed — waiting before retry');
        this.collector.appendLog('  ⚠️ LLM failed — waiting before retry');
        return { thinking: 'LLM error — waiting to retry', action: 'wait', seconds: 2 };
    }

    // -----------------------------------------------------------------------
    // System Prompt
    // -----------------------------------------------------------------------

    private getSystemPrompt(): string {
        return capabilitiesPrompt + '\n\n' + this.getInstructionPrompt();
    }

    private dataUrlToAnthropicSource(dataUrl: string): { type: 'base64'; media_type: string; data: string } {
        const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (!match) {
            return { type: 'base64', media_type: 'image/jpeg', data: dataUrl };
        }
        return { type: 'base64', media_type: match[1], data: match[2] };
    }

    // -----------------------------------------------------------------------
    // Reference Images
    // -----------------------------------------------------------------------

    private loadReferenceImages(): void {
        const folder = this.getReferenceImageFolder();
        if (!folder) return;

        const examplesDir = path.join(__dirname, '../../src/main/prompts/examples');
        const phaseDir = path.join(examplesDir, folder);

        try {
            if (!fs.existsSync(phaseDir)) return;

            const imagePattern = /\.(jpg|jpeg|png|webp)$/i;
            const images: Array<{ label: string; base64: string }> = [];

            const readImageBase64 = (filePath: string): string => {
                const buffer = fs.readFileSync(filePath);
                const ext = path.extname(filePath).toLowerCase().replace('.', '');
                const mime = ext === 'jpg' ? 'jpeg' : ext;
                return `data:image/${mime};base64,${buffer.toString('base64')}`;
            };

            const cleanName = (name: string) =>
                path.basename(name, path.extname(name)).replace(/[-_.]/g, ' ').trim();

            // Direct images in the phase folder
            const files = fs.readdirSync(phaseDir)
                .filter(f => imagePattern.test(f) && fs.statSync(path.join(phaseDir, f)).isFile())
                .sort();
            for (const file of files) {
                images.push({
                    label: `${folder} - ${cleanName(file)}`,
                    base64: readImageBase64(path.join(phaseDir, file))
                });
            }

            // Nested subdirectories (sub-flows)
            const nestedDirs = fs.readdirSync(phaseDir)
                .filter(f => fs.statSync(path.join(phaseDir, f)).isDirectory())
                .sort();
            for (const subdir of nestedDirs) {
                const subdirPath = path.join(phaseDir, subdir);
                const nestedFiles = fs.readdirSync(subdirPath)
                    .filter(f => imagePattern.test(f))
                    .sort();
                for (const file of nestedFiles) {
                    images.push({
                        label: `${folder} - ${cleanName(subdir)} - ${cleanName(file)}`,
                        base64: readImageBase64(path.join(subdirPath, file))
                    });
                }
            }

            if (images.length > 0) {
                this.referenceImages = images;
                console.log(`  📎 Loaded ${images.length} reference image(s) for ${folder}`);
                this.collector.appendLog(`📎 Loaded ${images.length} reference image(s) for ${folder}`);
            }
        } catch (err) {
            console.warn('  ⚠️ Failed to load reference images:', err);
            this.collector.appendLog(`⚠️ Failed to load reference images: ${err}`);
        }
    }

    // -----------------------------------------------------------------------
    // Per-Turn User Prompt
    // -----------------------------------------------------------------------

    protected buildUserPrompt(remainingMs: number): string {
        const elapsedSec = Math.round((Date.now() - this.startTime) / 1000);
        const elapsedMin = Math.round(elapsedSec / 60);
        const remainingMin = Math.round(remainingMs / 60000);

        const parts: string[] = [];

        parts.push(`SESSION: ${elapsedMin} min elapsed, ${remainingMin} min remaining.`);

        // Tab state
        if (this.originalPage && this.page !== this.originalPage) {
            parts.push(`TAB: You are in a NEW TAB (opened via newtab). Use closetab to return to the main tab when done here.`);
        }

        parts.push(`SCREENSHOTS: ${this.rawCount} raw screenshots saved (filter runs async)`);

        // Last action + intent feedback
        if (this.lastAction && this.actionHistory.length > 0) {
            const last = this.actionHistory[this.actionHistory.length - 1];
            parts.push(`\nYOUR LAST ACTION: ${this.formatAction(this.lastAction)}`);
            if (this.lastIntent) {
                parts.push(`YOUR INTENT: ${this.lastIntent}`);
            }
            if (this.lastExpectedState) {
                parts.push(`YOUR EXPECTED STATE: ${this.lastExpectedState}`);
            }
            if (this.lastRecoveryPlan) {
                parts.push(`YOUR RECOVERY PLAN: ${this.lastRecoveryPlan}`);
            }
            parts.push(`RESULT: ${last.result}`);
            parts.push('');
            parts.push('Does the current screenshot match your expected state?');
            parts.push('- If YES: continue with your plan.');
            parts.push('- If NO: execute your recovery plan FIRST, then reassess.');
        }

        // Recent history
        if (this.actionHistory.length > 0) {
            parts.push('\nRECENT HISTORY:');
            const recent = this.actionHistory.slice(-8);
            recent.forEach((entry, i) => {
                parts.push(`${i + 1}. ${entry.action} → ${entry.result}`);
            });
        }

        if (this.rawCount > 0) {
            parts.push(`RAW SCREENSHOTS: ${this.rawCount} saved so far`);
        }

        // Session memory digest (cross-session)
        if (this.config.sessionMemoryDigest) {
            parts.push(`\nSESSION CONTEXT:\n${this.config.sessionMemoryDigest}`);
        }

        // LLM's scratchpad
        if (this.lastMemory) {
            parts.push(`\nYOUR NOTES (from last turn):\n${this.lastMemory}`);
        }

        // Labeled elements with enriched descriptions
        if (this.currentElements.size > 0) {
            parts.push('\nLABELED ELEMENTS:');
            for (const [id, el] of this.currentElements) {
                const desc = el.text || el.ariaLabel || '';
                const descStr = desc ? ` "${desc.slice(0, 50)}"` : '';
                const href = el.href ? ` → ${el.href.slice(0, 40)}` : '';
                // Look up enriched description from element knowledge
                const fp = elementFingerprint(el);
                const note = this.elementKnowledge.get(fp);
                const noteStr = note ? ` — ${note}` : '';
                parts.push(`[${id}] ${el.tag}${descStr}${href}${noteStr}`);
            }
        }

        // Persistent learned lessons
        if (this.learnedLessons.length > 0) {
            parts.push('\nLEARNED (persistent):');
            for (const lesson of this.learnedLessons) {
                parts.push(`- ${lesson}`);
            }
        }

        // Periodic workflow reminder (every 10 turns)
        if (this.decisionCount > 0 && this.decisionCount % 10 === 0) {
            parts.push('\nREMINDER: Stay on workflow. Which reference image scenario matches what you see right now? Follow that scenario\'s steps.');
        }

        parts.push('\nWhat do you do next?');

        return parts.join('\n');
    }

    // -----------------------------------------------------------------------
    // Debug Screenshot Saving
    // -----------------------------------------------------------------------

    protected async saveDebugScreenshot(labeledScreenshot: Buffer, decision: VisionAction): Promise<void> {
        const agentDebugDir = this.collector.getAgentDebugDir(this.getAgentName());
        if (!agentDebugDir) return;

        try {
            // Create per-turn folder: turn_001_click/
            const turnName = `turn_${String(this.decisionCount).padStart(3, '0')}_${decision.action}`;
            const turnDir = path.join(agentDebugDir, turnName);
            fs.mkdirSync(turnDir, { recursive: true });

            // 1. Save labeled screenshot with red crosshair
            const image = await Jimp.read(Buffer.from(labeledScreenshot));
            const RED = 0xFF0000FF;

            if (['click', 'hover', 'newtab'].includes(decision.action) && decision.element !== undefined) {
                const el = this.currentElements.get(decision.element);
                if (el) {
                    const scaleX = this.screenshotWidth / this.viewportWidth;
                    const scaleY = this.screenshotHeight / this.viewportHeight;
                    const cx = Math.round((el.x + el.width / 2) * scaleX);
                    const cy = Math.round((el.y + el.height / 2) * scaleY);
                    const armLen = 15;
                    const thickness = 3;

                    for (let dx = -armLen; dx <= armLen; dx++) {
                        for (let dt = -Math.floor(thickness / 2); dt <= Math.floor(thickness / 2); dt++) {
                            const px = cx + dx;
                            const py = cy + dt;
                            if (px >= 0 && px < image.width && py >= 0 && py < image.height) {
                                image.setPixelColor(RED, px, py);
                            }
                        }
                    }
                    for (let dy = -armLen; dy <= armLen; dy++) {
                        for (let dt = -Math.floor(thickness / 2); dt <= Math.floor(thickness / 2); dt++) {
                            const px = cx + dt;
                            const py = cy + dy;
                            if (px >= 0 && px < image.width && py >= 0 && py < image.height) {
                                image.setPixelColor(RED, px, py);
                            }
                        }
                    }
                }
            }

            const labeledBuffer = await image.getBuffer('image/jpeg', { quality: 85 });
            fs.writeFileSync(path.join(turnDir, 'labeled.jpg'), labeledBuffer);

            // 2. Save raw screenshot (no badges, no crosshair)
            if (this.lastRawScreenshot) {
                fs.writeFileSync(path.join(turnDir, 'raw.jpg'), this.lastRawScreenshot);
            }

            // 3. Save metadata JSON with full turn state
            const clickedEl = (decision.element !== undefined)
                ? (() => {
                    const el = this.currentElements.get(decision.element!);
                    return el ? { id: el.id, center_x: Math.round(el.x + el.width / 2), center_y: Math.round(el.y + el.height / 2) } : null;
                })()
                : null;

            const metadata = {
                turn: this.decisionCount,
                agent: this.getAgentName(),
                timestamp: new Date().toISOString(),
                elapsed_ms: Date.now() - this.startTime,
                remaining_ms: this.config.maxDurationMs - (Date.now() - this.startTime),

                decision: {
                    thinking: decision.thinking,
                    action: decision.action,
                    element: decision.element ?? null,
                    direction: decision.direction ?? null,
                    key: decision.key ?? null,
                    text: decision.text ?? null,
                    intent: decision.intent ?? null,
                    expected_state: decision.expected_state ?? null,
                    if_wrong: decision.if_wrong ?? null,
                    memory: decision.memory ?? null,
                    lesson: decision.lesson ?? null,
                },

                elements: Array.from(this.currentElements.values()).map(el => ({
                    id: el.id,
                    tag: el.tag,
                    text: el.text,
                    ariaLabel: el.ariaLabel,
                    href: el.href,
                    x: el.x,
                    y: el.y,
                    width: el.width,
                    height: el.height,
                    note: this.elementKnowledge.get(elementFingerprint(el)) ?? null,
                })),

                clicked_element: clickedEl,

                action_history: this.actionHistory.slice(-8).map(h => `${h.action} → ${h.result}`),

                learned_lessons: [...this.learnedLessons],

                element_knowledge_snapshot: Object.fromEntries(this.elementKnowledge),

                tokens: this.lastTokenUsage ? {
                    input: this.lastTokenUsage.promptTokens,
                    output: this.lastTokenUsage.completionTokens,
                } : null,
            };

            fs.writeFileSync(
                path.join(turnDir, 'metadata.json'),
                JSON.stringify(metadata, null, 2)
            );

        } catch (err) {
            console.warn(`  ⚠️ Debug screenshot save failed:`, err);
        }
    }

    // -----------------------------------------------------------------------
    // Utilities
    // -----------------------------------------------------------------------

    protected parseJsonResponse(content: string): VisionAction {
        const trimmed = content.trim();
        try {
            return JSON.parse(trimmed) as VisionAction;
        } catch {
            // Fall through
        }

        const codeBlockMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (codeBlockMatch) {
            return JSON.parse(codeBlockMatch[1]) as VisionAction;
        }

        const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]) as VisionAction;
        }

        throw new SyntaxError(`No JSON found in response: ${trimmed.slice(0, 100)}`);
    }

    protected delay(ms: number): Promise<void> {
        return new Promise((resolve) => {
            const timer = setTimeout(resolve, ms);
            const onAbort = () => { clearTimeout(timer); resolve(); };
            if (this.abortController.signal.aborted) { clearTimeout(timer); resolve(); return; }
            this.abortController.signal.addEventListener('abort', onAbort, { once: true });
        });
    }

    protected formatAction(d: VisionAction): string {
        switch (d.action) {
            case 'click': return `click([${d.element}])`;
            case 'scroll': return `scroll(${d.direction || 'down'})`;
            case 'type': return `type("${(d.text || '').slice(0, 20)}")`;
            case 'press': return `press(${d.key})`;
            case 'hover': return `hover([${d.element}])`;
            case 'wait': return `wait(${d.seconds || 2}s)`;
            case 'newtab': return `newtab([${d.element}])`;
            case 'closetab': return 'closetab';
            case 'goback': return 'goback';
            case 'done': return 'done';
            default: return d.action;
        }
    }

    // Public getters
    getRawScreenshotCount(): number { return this.rawCount; }
    getDecisionCount(): number { return this.decisionCount; }
    getActionHistory(): ActionHistoryEntry[] { return [...this.actionHistory]; }
}