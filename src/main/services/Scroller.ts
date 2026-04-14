/**
 * VisionAgent - Dual-Agent Instagram Browsing System
 *
 * Navigator (Sonnet) handles all navigation — scrolling, clicking, dismissing popups.
 * Specialist (Opus) handles captures, carousels, stories, and stuck recovery.
 *
 * Core loop: screenshot → label elements → Navigator LLM → action → repeat
 * On handoff: screenshot → label elements → Specialist LLM → capture → repeat until done
 *
 * Stealth: all labeling is server-side on the screenshot buffer. No DOM
 * modifications, no injected scripts. GhostMouse handles all clicks.
 */

import { Page } from 'playwright';
import { Jimp } from 'jimp';
import fs from 'fs';
import path from 'path';
import { GhostMouse } from './GhostMouse.js';
import { HumanScroll } from './HumanScroll.js';
import { ScreenshotCollector } from './ScreenshotCollector.js';
import { ModelConfig } from '../../shared/modelConfig.js';
// CaptureSource import removed — no longer used (capture handled by filter agent)
import navigatorPrompt from '../prompts/navigator-agent.md';
import specialistPrompt from '../prompts/specialist-agent.md';
import { labelElements, type LabeledElement } from '../../utils/elementLabeler.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** LLM response schema — the complete output format. */
interface VisionAction {
    thinking: string;
    action: 'click' | 'scroll' | 'type' | 'press' | 'hover' | 'wait' | 'done' | 'newtab' | 'closetab' | 'handoff' | 'escalate';
    element?: number;  // Element label number for click/hover/newtab
    direction?: 'up' | 'down';
    text?: string;
    key?: string;
    seconds?: number;
    memory?: string;
    phase?: 'posts' | 'search' | 'stories';
    result?: string;   // Specialist's done result message
}

interface ActionHistoryEntry {
    action: string;
    result: string;
}

export interface ScrollerConfig {
    apiKey: string;
    maxDurationMs: number;
    userInterests: string[];
    debugMode?: boolean;
    sessionMemoryDigest?: string;
    rawDir?: string;  // Directory for raw screenshot dumps (three-agent pipeline)
}

export interface ScrollerResult {
    rawScreenshotCount: number;
    decisionCount: number;
    actionHistory: ActionHistoryEntry[];
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const SCREENSHOT_WIDTH = 1280;

// ---------------------------------------------------------------------------
// VisionAgent
// ---------------------------------------------------------------------------

export class Scroller {
    private page: Page;
    private ghost: GhostMouse;
    private scroll: HumanScroll;
    private collector: ScreenshotCollector;
    private config: ScrollerConfig;

    // Screenshot dimensions (updated after each resize)
    private screenshotWidth: number = SCREENSHOT_WIDTH;
    private screenshotHeight: number = 0;

    // Viewport dimensions (set once at run() start)
    private viewportWidth: number = 0;
    private viewportHeight: number = 0;

    // LLM state — dual model
    private model: string;              // Navigator (Sonnet)
    private specialistModel: string;    // Specialist (Opus)
    private activeModel: 'navigator' | 'specialist' = 'navigator';
    private lastMemory: string = '';
    private actionHistory: ActionHistoryEntry[] = [];
    private decisionCount: number = 0;
    private lastTokenUsage: { promptTokens: number; completionTokens: number } | null = null;

    // Session state
    private startTime: number = 0;

    // Raw screenshot dump for three-agent pipeline
    private rawDir: string = '';
    private rawCount: number = 0;

    // Reference example images organized by phase folder (Posts, Search, Stories)
    private referenceImagesByPhase: Map<string, Array<{ label: string; base64: string }>> | null = null;
    private sentPhases: Set<string> = new Set();
    private lastDeclaredPhase: string = ''; // Set by LLM on first turn; empty = no phase yet

    // Tab management — tracks the original tab so closetab can return to it
    private originalPage: Page | null = null;

    // Current turn's labeled elements (for click/hover/newtab execution)
    private currentElements: Map<number, LabeledElement> = new Map();

    // Previous action tracking (for REFLECT step context)
    private lastAction: VisionAction | null = null;

    // Specialist result — fed back to navigator on next turn
    private lastSpecialistResult: string = '';

    // External stop signal (set by Cmd+Shift+K)
    private stopped: boolean = false;

    constructor(
        page: Page,
        ghost: GhostMouse,
        scroll: HumanScroll,
        collector: ScreenshotCollector,
        config: ScrollerConfig
    ) {
        this.page = page;
        this.ghost = ghost;
        this.scroll = scroll;
        this.collector = collector;
        this.config = config;
        this.model = ModelConfig.navigation;
        this.specialistModel = ModelConfig.specialist;
    }

    // -----------------------------------------------------------------------
    // Main Loop
    // -----------------------------------------------------------------------

    /** Stop the agent externally (e.g. Cmd+Shift+K). */
    stop(): void {
        this.stopped = true;
        console.log('🛑 VisionAgent: external stop signal received');
        this.collector.appendLog('🛑 External stop signal received');
    }

    async run(): Promise<ScrollerResult> {
        this.startTime = Date.now();
        const vp = this.page.viewportSize();
        this.viewportWidth = vp?.width || 1080;
        this.viewportHeight = vp?.height || 1920;

        console.log(`\n👁️  VisionAgent starting (viewport: ${this.viewportWidth}x${this.viewportHeight}, navigator: ${this.model}, specialist: ${this.specialistModel})`);
        this.collector.appendLog(`👁️ VisionAgent starting (viewport: ${this.viewportWidth}x${this.viewportHeight}, navigator: ${this.model}, specialist: ${this.specialistModel})`);

        // Set up raw screenshot directory for the three-agent pipeline
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

        while (true) {
            // Check external stop signal (Cmd+Shift+K)
            if (this.stopped) {
                console.log('🛑 VisionAgent: stopped by user');
                this.collector.appendLog('🛑 Stopped by user (Cmd+Shift+K)');
                break;
            }

            const elapsed = Date.now() - this.startTime;
            const remaining = this.config.maxDurationMs - elapsed;
            if (remaining <= 0) {
                console.log('⏱️  VisionAgent: time limit reached');
                this.collector.appendLog('⏱️ Time limit reached');
                break;
            }

            // 1. Take and resize screenshot
            const rawScreenshot = await this.captureScreenshot();
            if (!rawScreenshot) {
                await this.delay(500);
                continue;
            }

            // Save raw screenshot for filter agent (Agent 2)
            this.saveRawScreenshot(rawScreenshot);

            // 1b. Detect interactive elements and draw labels on screenshot
            const { buffer: screenshot, elements } = await labelElements(
                this.page, rawScreenshot,
                this.screenshotWidth, this.screenshotHeight,
                this.viewportWidth, this.viewportHeight
            );
            this.currentElements = elements;
            console.log(`  🏷️ Labeled ${elements.size} interactive elements`);

            // 2. Call Navigator LLM
            this.activeModel = 'navigator';
            const decision = await this.callLLM(screenshot, remaining);
            this.decisionCount++;

            console.log(`  🧭 [${this.decisionCount}] action=${decision.action} | ${decision.thinking.slice(0, 80)}`);

            // 2b. Log full reasoning for element-based actions (click/hover/newtab)
            if (['click', 'hover', 'newtab'].includes(decision.action) && decision.element !== undefined) {
                const el = this.currentElements.get(decision.element);
                const desc = el ? `"${el.text || el.ariaLabel || el.tag}"` : 'unknown';
                const coordLog = `[${this.decisionCount}] ${decision.action}([${decision.element}] ${desc}) — ${decision.thinking}`;
                console.log(`  📍 ${coordLog}`);
                this.collector.appendLog(`📍 ${coordLog}`);
            }

            // 2c. Save debug screenshot with action overlay
            await this.saveDebugScreenshot(screenshot, decision);

            // 3. Handle "done" — LLM terminates session
            if (decision.action === 'done') {
                console.log(`✅ VisionAgent: LLM ended session — ${decision.thinking}`);
                this.collector.appendLog(`✅ LLM ended session — ${decision.thinking}`);
                break;
            }

            // 3b. Handle handoff — switch to specialist for captures
            if (decision.action === 'handoff') {
                console.log('  🔄 Handoff to specialist (Opus) for capture');
                this.collector.appendLog('🔄 Handoff to specialist (Opus) for capture');

                // Persist navigator memory before handoff
                if (decision.memory) this.lastMemory = decision.memory;
                if (decision.phase) this.updatePhase(decision.phase);

                const specialistResult = await this.runSpecialist('capture');
                this.lastSpecialistResult = specialistResult;

                // Record handoff in history
                this.actionHistory.push({
                    action: 'handoff',
                    result: `Specialist: ${specialistResult.slice(0, 100)}`
                });

                // Log
                const tokenStr = this.lastTokenUsage
                    ? ` | ${this.lastTokenUsage.promptTokens}+${this.lastTokenUsage.completionTokens} tokens`
                    : '';
                this.collector.appendLog(`[${this.decisionCount}] handoff${tokenStr}`);
                this.collector.appendLog(`  💭 ${decision.thinking}`);
                if (decision.memory) this.collector.appendLog(`  📝 Memory: ${decision.memory}`);

                continue;
            }

            // 3c. Handle escalate — switch to specialist for rescue
            if (decision.action === 'escalate') {
                console.log('  🆘 Escalating to specialist (Opus) for rescue');
                this.collector.appendLog('🆘 Escalating to specialist (Opus) for rescue');

                if (decision.memory) this.lastMemory = decision.memory;

                const specialistResult = await this.runSpecialist('rescue');
                this.lastSpecialistResult = specialistResult;

                this.actionHistory.push({
                    action: 'escalate',
                    result: `Specialist: ${specialistResult.slice(0, 100)}`
                });

                const tokenStr = this.lastTokenUsage
                    ? ` | ${this.lastTokenUsage.promptTokens}+${this.lastTokenUsage.completionTokens} tokens`
                    : '';
                this.collector.appendLog(`[${this.decisionCount}] escalate${tokenStr}`);
                this.collector.appendLog(`  💭 ${decision.thinking}`);
                if (decision.memory) this.collector.appendLog(`  📝 Memory: ${decision.memory}`);

                continue;
            }

            // 4. Persist memory scratchpad and phase declaration
            if (decision.memory) {
                this.lastMemory = decision.memory;
            }
            let phaseChangeDeferred = false;
            if (decision.phase) {
                phaseChangeDeferred = this.updatePhase(decision.phase);
            }

            // 5. Execute action (or defer if phase just changed and images need loading)
            let result: string;
            if (phaseChangeDeferred) {
                result = `Phase changed to ${this.lastDeclaredPhase!.toLowerCase()}. Reference images loading — review them on the next turn and then act.`;
            } else {
                result = await this.executeAction(decision);
            }
            console.log(`     → ${result}`);

            // 5b. Track last action for REFLECT step context
            this.lastAction = decision;

            // 6. Record to history
            this.actionHistory.push({
                action: this.formatAction(decision),
                result
            });

            // 7. Log to session file
            const tokenStr = this.lastTokenUsage
                ? ` | ${this.lastTokenUsage.promptTokens}+${this.lastTokenUsage.completionTokens} tokens`
                : '';
            this.collector.appendLog(`[${this.decisionCount}] ${this.formatAction(decision)}${tokenStr}`);
            this.collector.appendLog(`  💭 ${decision.thinking}`);
            this.collector.appendLog(`  → ${result}`);
            if (decision.memory) {
                this.collector.appendLog(`  📝 Memory: ${decision.memory}`);
            }

        }

        // Signal to the filter agent that navigation is complete
        if (this.rawDir) {
            fs.writeFileSync(path.join(this.rawDir, 'done.marker'), JSON.stringify({
                totalScreenshots: this.rawCount,
                totalDecisions: this.decisionCount,
                timestamp: Date.now()
            }));
        }

        console.log(`\n👁️  VisionAgent finished: ${this.rawCount} raw screenshots, ${this.decisionCount} decisions\n`);
        this.collector.appendLog(`👁️ VisionAgent finished: ${this.rawCount} raw screenshots, ${this.decisionCount} decisions`);

        return {
            rawScreenshotCount: this.rawCount,
            decisionCount: this.decisionCount,
            actionHistory: [...this.actionHistory]
        };
    }

    // -----------------------------------------------------------------------
    // Specialist Sub-Loop
    // -----------------------------------------------------------------------

    private async runSpecialist(mode: 'capture' | 'rescue'): Promise<string> {
        this.activeModel = 'specialist';
        let specialistTurns = 0;
        const maxTurns = mode === 'capture' ? 20 : 5;
        let resultMessage = '';

        while (specialistTurns < maxTurns) {
            specialistTurns++;

            // Check stop signal
            if (this.stopped) {
                resultMessage = 'Stopped by user.';
                break;
            }

            // Take screenshot
            const rawScreenshot = await this.captureScreenshot();
            if (!rawScreenshot) { await this.delay(500); continue; }

            // Save raw screenshot for filter agent (Agent 2)
            this.saveRawScreenshot(rawScreenshot);

            const { buffer: screenshot, elements } = await labelElements(
                this.page, rawScreenshot,
                this.screenshotWidth, this.screenshotHeight,
                this.viewportWidth, this.viewportHeight
            );
            this.currentElements = elements;

            // Call specialist model
            const decision = await this.callLLM(screenshot, this.config.maxDurationMs - (Date.now() - this.startTime));
            this.decisionCount++;

            console.log(`  🎯 [Specialist ${specialistTurns}] action=${decision.action} | ${decision.thinking.slice(0, 80)}`);
            this.collector.appendLog(`🎯 [Specialist ${specialistTurns}] ${this.formatAction(decision)} | ${decision.thinking.slice(0, 80)}`);

            // Save debug screenshot
            await this.saveDebugScreenshot(screenshot, decision);

            // Specialist says done — return to navigator
            if (decision.action === 'done') {
                resultMessage = decision.result || decision.thinking;
                break;
            }

            // Execute the action normally
            const result = await this.executeAction(decision);

            // Track last action for context
            this.lastAction = decision;
            this.actionHistory.push({ action: `[specialist] ${this.formatAction(decision)}`, result });

            // Log
            this.collector.appendLog(`  → ${result}`);
            if (decision.memory) {
                this.collector.appendLog(`  📝 Memory: ${decision.memory}`);
                this.lastMemory = decision.memory;
            }
        }

        if (!resultMessage && specialistTurns >= maxTurns) {
            resultMessage = `Specialist timed out after ${maxTurns} turns in ${mode} mode.`;
        }

        // Switch back to navigator
        this.activeModel = 'navigator';
        console.log(`  🔄 Returning to navigator. Specialist result: ${resultMessage.slice(0, 100)}`);
        this.collector.appendLog(`🔄 Specialist done: ${resultMessage.slice(0, 100)}`);

        return resultMessage;
    }

    // -----------------------------------------------------------------------
    // Phase Management
    // -----------------------------------------------------------------------

    /** Update phase from LLM declaration. Returns true if action should be deferred. */
    private updatePhase(phase: string): boolean {
        const phaseMap: Record<string, string> = { posts: 'Posts', search: 'Search', stories: 'Stories' };
        const folder = phaseMap[phase];
        if (!folder || folder === this.lastDeclaredPhase) return false;

        if (this.lastDeclaredPhase) {
            console.log(`  📂 Phase changed: ${this.lastDeclaredPhase} → ${folder}`);
            this.collector.appendLog(`📂 Phase changed: ${this.lastDeclaredPhase} → ${folder}`);
        } else {
            console.log(`  📂 Starting phase: ${folder}`);
            this.collector.appendLog(`📂 Starting phase: ${folder}`);
        }
        this.lastDeclaredPhase = folder;

        // If reference images for the new phase haven't been sent yet,
        // defer this turn's action so the LLM sees the images first
        const allPhaseImages = this.loadReferenceImagesByPhase();
        const hasUnsentImages = !this.sentPhases.has(folder) &&
            (allPhaseImages.get(folder)?.length ?? 0) > 0;

        if (hasUnsentImages) {
            console.log(`  📎 Deferring action — loading ${folder} reference images first`);
            this.collector.appendLog(`📎 Deferring action — loading ${folder} reference images first`);
            return true;
        }

        return false;
    }

    // -----------------------------------------------------------------------
    // Screenshot Capture & Resize
    // -----------------------------------------------------------------------

    private async captureScreenshot(): Promise<Buffer | null> {
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
    // Raw Screenshot Dump (Three-Agent Pipeline)
    // -----------------------------------------------------------------------

    /**
     * Save a raw screenshot to the raw/ directory for the filter agent.
     * Every navigation screenshot gets saved — no filtering, no dedup.
     * The filter agent (Agent 2) handles quality decisions.
     */
    private saveRawScreenshot(buffer: Buffer): void {
        if (!this.rawDir) return;
        this.rawCount++;
        const padded = this.rawCount.toString().padStart(3, '0');
        fs.writeFileSync(path.join(this.rawDir, `${padded}.jpg`), buffer);
        fs.writeFileSync(path.join(this.rawDir, `${padded}.json`), JSON.stringify({
            turn: this.decisionCount,
            phase: this.lastDeclaredPhase || 'unknown',
            timestamp: Date.now(),
            agent: this.activeModel
        }));
    }

    // -----------------------------------------------------------------------
    // Action Execution
    // -----------------------------------------------------------------------

    private async executeAction(decision: VisionAction): Promise<string> {
        switch (decision.action) {
            case 'click': return this.executeClick(decision);
            case 'scroll': return this.executeScroll(decision);
            case 'type': return this.executeType(decision);
            case 'press': return this.executePress(decision);
            case 'hover': return this.executeHover(decision);
            case 'wait': return this.executeWait(decision);
            case 'newtab': return this.executeNewtab(decision);
            case 'closetab': return this.executeClosetab();
            default: return `unknown action: ${decision.action}`;
        }
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

        // SAFETY GUARDRAIL: check focused input context
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

        // Save the current page as the original if this is the first newtab
        if (!this.originalPage) {
            this.originalPage = this.page;
        }

        try {
            // Move mouse naturally to the target, then middle-click to open in new tab
            await this.ghost.moveTo({ x: cx, y: cy });

            // Listen for the new page event BEFORE clicking
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

    private async executeClosetab(): Promise<string> {
        if (!this.originalPage) {
            console.log(`  ❎ closetab: no tab to close — already on main tab`);
            this.collector.appendLog(`❎ closetab: no tab to close — already on main tab`);
            return 'no tab to close — already on the main tab';
        }

        // If we're on the original page, nothing to close
        if (this.page === this.originalPage) {
            this.originalPage = null;
            console.log(`  ❎ closetab: already on main tab`);
            this.collector.appendLog(`❎ closetab: already on main tab`);
            return 'already on main tab';
        }

        const closingUrl = this.page.url();
        console.log(`  ❎ closetab: closing ${closingUrl}`);
        this.collector.appendLog(`❎ closetab: closing ${closingUrl}`);
        try {
            await this.page.close();
        } catch {
            // Page may already be closed
        }

        // Switch back to the original page
        this.switchToPage(this.originalPage);
        this.originalPage = null;

        console.log(`  ❎ closetab: back to ${this.page.url()}`);
        this.collector.appendLog(`❎ closetab: back to ${this.page.url()}`);
        return `closed tab (was: ${closingUrl}), back to ${this.page.url()}`;
    }

    /** Rebind all services to a different page/tab. */
    private switchToPage(page: Page): void {
        this.page = page;
        this.ghost.setPage(page);
        this.scroll.setPage(page);
        this.collector.setPage(page);

        // Update viewport dimensions for the new page
        const vp = page.viewportSize();
        if (vp) {
            this.viewportWidth = vp.width;
            this.viewportHeight = vp.height;
        }
    }

    // -----------------------------------------------------------------------
    // Safety Guardrail — Input Context Detection
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

    private async callLLM(screenshot: Buffer, remainingMs: number): Promise<VisionAction> {
        const systemPrompt = this.getSystemPrompt();
        const userPrompt = this.buildUserPrompt(remainingMs);
        const visionDetail = process.env.KOWALSKI_VISION_DETAIL || 'high';

        // Build messages array
        const messages: Array<Record<string, unknown>> = [];

        // Inject reference images only for navigator (specialist works from current screenshot)
        if (this.activeModel === 'navigator') {
            const allPhaseImages = this.loadReferenceImagesByPhase();
            const phase = this.lastDeclaredPhase;
            if (phase && !this.sentPhases.has(phase)) {
                const refContent: Array<Record<string, unknown>> = [];

                // Include general images (e.g. goinghome.png) on the very first injection
                if (this.sentPhases.size === 0) {
                    const generalImages = allPhaseImages.get('general') || [];
                    for (const ref of generalImages) {
                        refContent.push({
                            type: 'image',
                            source: this.dataUrlToAnthropicSource(ref.base64)
                        });
                        refContent.push({
                            type: 'text',
                            text: `[Reference: ${ref.label}]`
                        });
                    }
                }

                // Include this phase's images (numbered step-by-step workflow)
                const phaseImages = allPhaseImages.get(phase) || [];
                for (const ref of phaseImages) {
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
                    refContent.push({
                        type: 'text',
                        text: `These are step-by-step instructions for how to handle ${phase.toLowerCase()} on Instagram. The images are numbered — follow them in sequence. Read the annotations in each image carefully.`
                    });
                    messages.push({ role: 'user', content: refContent });
                    messages.push({
                        role: 'assistant',
                        content: `Understood. I'll follow the ${phase.toLowerCase()} workflow steps shown above.`
                    });
                    console.log(`  📎 Injected ${phase} reference images (${phaseImages.length} images)`);
                    this.collector.appendLog(`📎 Injected ${phase} reference images (${phaseImages.length} images)`);
                }
                this.sentPhases.add(phase);
            }
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

        // Build request body — different config per model
        const isSpecialist = this.activeModel === 'specialist';
        const requestBody: Record<string, unknown> = {
            model: isSpecialist ? this.specialistModel : this.model,
            system: [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }],
            messages,
            max_tokens: isSpecialist ? 16000 : 2048,
        };

        // Only enable extended thinking for specialist (Opus)
        if (isSpecialist) {
            requestBody.thinking = { type: 'enabled', budget_tokens: 10000 };
        }

        // Attempt LLM call with exponential backoff on overload/rate-limit
        const maxRetries = 4;
        for (let attempt = 0; attempt < maxRetries; attempt++) {
            try {
                const response = await fetch('https://api.anthropic.com/v1/messages', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': this.config.apiKey,
                        'anthropic-version': '2023-06-01',
                        'anthropic-beta': 'prompt-caching-2024-07-31'
                    },
                    body: JSON.stringify(requestBody)
                });

                if (!response.ok) {
                    const errText = await response.text();
                    console.warn(`  ⚠️ LLM API error (${response.status}): ${errText.slice(0, 200)}`);
                    this.collector.appendLog(`  ⚠️ LLM API error (${response.status}): ${errText.slice(0, 200)}`);
                    // Retry on overload (529) or rate limit (429) with exponential backoff
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
                    break; // Don't retry other API errors
                }

                const data = await response.json() as Record<string, unknown>;

                // Log token usage
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
                // Skip 'thinking' blocks from extended thinking — only extract the 'text' block
                const textBlock = contentBlocks?.find(b => b.type === 'text');
                const content = textBlock?.text;
                if (!content || typeof content !== 'string') {
                    console.warn(`  ⚠️ Empty LLM response (attempt ${attempt + 1}/${maxRetries})`);
                    this.collector.appendLog(`  ⚠️ Empty LLM response (attempt ${attempt + 1}/${maxRetries})`);
                    if (attempt < maxRetries - 1) { await this.delay(500); continue; }
                    break;
                }

                const parsed = this.parseJsonResponse(content);
                return parsed;

            } catch (err) {
                console.warn(`  ⚠️ LLM call/parse error (attempt ${attempt + 1}/${maxRetries}):`, err);
                this.collector.appendLog(`  ⚠️ LLM call/parse error (attempt ${attempt + 1}/${maxRetries}): ${err}`);
                if (attempt < maxRetries - 1) { await this.delay(500); continue; }
            }
        }

        // Fallback: wait and let the LLM retry next iteration (no autonomous actions)
        console.warn('  ⚠️ LLM failed — waiting before retry');
        this.collector.appendLog('  ⚠️ LLM failed — waiting before retry');
        return { thinking: 'LLM error — waiting to retry', action: 'wait', seconds: 2 };
    }

    // -----------------------------------------------------------------------
    // System Prompt
    // -----------------------------------------------------------------------

    /**
     * Convert a data URL (data:image/jpeg;base64,...) to Anthropic image source format.
     */
    private dataUrlToAnthropicSource(dataUrl: string): { type: 'base64'; media_type: string; data: string } {
        const match = dataUrl.match(/^data:(image\/[^;]+);base64,(.+)$/);
        if (!match) {
            return { type: 'base64', media_type: 'image/jpeg', data: dataUrl };
        }
        return { type: 'base64', media_type: match[1], data: match[2] };
    }

    private getSystemPrompt(): string {
        const prompt = this.activeModel === 'navigator' ? navigatorPrompt : specialistPrompt;
        return prompt
            .replace('{{SCREENSHOT_WIDTH}}', String(this.screenshotWidth))
            .replace('{{SCREENSHOT_HEIGHT}}', String(this.screenshotHeight));
    }

    /**
     * Load reference images from src/main/prompts/examples/, organized by folder.
     * Returns a Map: 'general' → root images, 'Posts' → Posts/, 'Search' → Search/, etc.
     * Images within each folder are sorted alphabetically (so numbered files stay in order).
     * Loaded once and cached for the session.
     */
    private loadReferenceImagesByPhase(): Map<string, Array<{ label: string; base64: string }>> {
        if (this.referenceImagesByPhase !== null) return this.referenceImagesByPhase;

        this.referenceImagesByPhase = new Map();
        const examplesDir = path.join(__dirname, '../../src/main/prompts/examples');

        try {
            if (!fs.existsSync(examplesDir)) return this.referenceImagesByPhase;

            const imagePattern = /\.(jpg|jpeg|png|webp)$/i;
            const loaded: string[] = [];

            const readImageBase64 = (filePath: string): string => {
                const buffer = fs.readFileSync(filePath);
                const ext = path.extname(filePath).toLowerCase().replace('.', '');
                const mime = ext === 'jpg' ? 'jpeg' : ext;
                return `data:image/${mime};base64,${buffer.toString('base64')}`;
            };

            const cleanName = (name: string) =>
                path.basename(name, path.extname(name)).replace(/[-_.]/g, ' ').trim();

            // Root-level images → 'general' group (e.g. goinghome.png)
            const rootFiles = fs.readdirSync(examplesDir)
                .filter(f => imagePattern.test(f) && fs.statSync(path.join(examplesDir, f)).isFile())
                .sort();
            if (rootFiles.length > 0) {
                const generalImages: Array<{ label: string; base64: string }> = [];
                for (const file of rootFiles) {
                    generalImages.push({ label: cleanName(file), base64: readImageBase64(path.join(examplesDir, file)) });
                    loaded.push(file);
                }
                this.referenceImagesByPhase.set('general', generalImages);
            }

            // Subdirectories → one group per folder name (Posts, Search, Stories)
            const subdirs = fs.readdirSync(examplesDir)
                .filter(f => fs.statSync(path.join(examplesDir, f)).isDirectory())
                .sort();
            for (const dir of subdirs) {
                const dirPath = path.join(examplesDir, dir);
                const phaseImages: Array<{ label: string; base64: string }> = [];

                // Direct images in this phase folder
                const files = fs.readdirSync(dirPath)
                    .filter(f => imagePattern.test(f))
                    .sort();
                for (const file of files) {
                    phaseImages.push({ label: `${dir} - ${cleanName(file)}`, base64: readImageBase64(path.join(dirPath, file)) });
                    loaded.push(path.join(dir, file));
                }

                // Nested subdirectories (sub-flows)
                const nestedDirs = fs.readdirSync(dirPath)
                    .filter(f => fs.statSync(path.join(dirPath, f)).isDirectory())
                    .sort();
                for (const subdir of nestedDirs) {
                    const subdirPath = path.join(dirPath, subdir);
                    const nestedFiles = fs.readdirSync(subdirPath)
                        .filter(f => imagePattern.test(f))
                        .sort();
                    for (const file of nestedFiles) {
                        phaseImages.push({
                            label: `${dir} - ${cleanName(subdir)} - ${cleanName(file)}`,
                            base64: readImageBase64(path.join(subdirPath, file))
                        });
                        loaded.push(path.join(dir, subdir, file));
                    }
                }

                if (phaseImages.length > 0) {
                    this.referenceImagesByPhase.set(dir, phaseImages);
                }
            }

            if (loaded.length > 0) {
                const phases = [...this.referenceImagesByPhase.keys()].join(', ');
                console.log(`  📎 Loaded ${loaded.length} reference image(s) in phases [${phases}]`);
                this.collector.appendLog(`📎 Loaded ${loaded.length} reference image(s) in phases [${phases}]`);
            }
        } catch (err) {
            console.warn('  ⚠️ Failed to load reference images:', err);
            this.collector.appendLog(`⚠️ Failed to load reference images: ${err}`);
        }

        return this.referenceImagesByPhase;
    }

    // -----------------------------------------------------------------------
    // Per-Turn User Prompt
    // -----------------------------------------------------------------------

    private buildUserPrompt(remainingMs: number): string {
        const elapsedSec = Math.round((Date.now() - this.startTime) / 1000);
        const elapsedMin = Math.round(elapsedSec / 60);
        const remainingMin = Math.round(remainingMs / 60000);

        const parts: string[] = [];

        parts.push(`SESSION: ${elapsedMin} min elapsed, ${remainingMin} min remaining. Use done when you've collected enough content across feed, stories, and searches.`);

        // Tab state — tell the LLM if it's in a secondary tab
        if (this.originalPage && this.page !== this.originalPage) {
            parts.push(`TAB: You are in a NEW TAB (opened via newtab). Use closetab to return to the main tab when done here. Do NOT navigate away — use closetab.`);
        }

        parts.push(`SCREENSHOTS: ${this.rawCount} raw screenshots saved (filter runs async)`);

        if (this.config.userInterests.length > 0) {
            parts.push(`INTERESTS TO SEARCH: ${this.config.userInterests.join(', ')}`);
        }

        // Specialist result — feed back to navigator
        if (this.lastSpecialistResult) {
            parts.push(`\nSPECIALIST RESULT: ${this.lastSpecialistResult}`);
            parts.push('The specialist has finished. Continue navigating based on its result.');
            this.lastSpecialistResult = ''; // Clear after sending
        }

        // Last action + result with verification prompt for REFLECT step
        if (this.lastAction && this.actionHistory.length > 0) {
            const last = this.actionHistory[this.actionHistory.length - 1];
            parts.push(`\nYOUR LAST ACTION: ${JSON.stringify({ action: this.lastAction.action, element: this.lastAction.element, thinking: this.lastAction.thinking })}`);
            parts.push(`RESULT: ${last.result}`);
            parts.push(`Did it work? Compare what you see now to what you expected.`);
        }

        // Recent history — capped at last 8
        if (this.actionHistory.length > 0) {
            parts.push('\nRECENT HISTORY:');
            const recent = this.actionHistory.slice(-8);
            recent.forEach((entry, i) => {
                parts.push(`${i + 1}. ${entry.action} → ${entry.result}`);
            });
        }

        // Raw screenshot count
        if (this.rawCount > 0) {
            parts.push(`RAW SCREENSHOTS: ${this.rawCount} saved so far`);
        }

        // Session memory digest (cross-session)
        if (this.config.sessionMemoryDigest) {
            parts.push(`\nSESSION CONTEXT:\n${this.config.sessionMemoryDigest}`);
        }

        // LLM's scratchpad from previous turn
        if (this.lastMemory) {
            parts.push(`\nYOUR NOTES (from last turn):\n${this.lastMemory}`);
        }

        // Text list of labeled elements (cross-reference with visual labels on screenshot)
        if (this.currentElements.size > 0) {
            parts.push('\nLABELED ELEMENTS:');
            for (const [id, el] of this.currentElements) {
                const desc = el.text || el.ariaLabel || '';
                const descStr = desc ? ` "${desc.slice(0, 50)}"` : '';
                parts.push(`[${id}] ${el.tag}${descStr}${el.href ? ' → ' + el.href.slice(0, 40) : ''}`);
            }
        }

        parts.push('\nWhat do you do next?');

        return parts.join('\n');
    }

    // -----------------------------------------------------------------------
    // Debug Screenshot Saving
    // -----------------------------------------------------------------------

    /**
     * Save the screenshot the LLM saw with action overlay drawn on it.
     * For click/hover/newtab: draws a red crosshair at the element's center in screenshot space.
     * For capture: draws a red rectangle for the crop region.
     * Saved to nav/ subdirectory within the session folder.
     */
    private async saveDebugScreenshot(screenshot: Buffer, decision: VisionAction): Promise<void> {
        const outputDir = this.collector.getNavDir();
        if (!outputDir) return;

        try {
            const image = await Jimp.read(Buffer.from(screenshot));
            const RED = 0xFF0000FF;

            // Draw crosshair at element center for click/hover/newtab
            if (['click', 'hover', 'newtab'].includes(decision.action) && decision.element !== undefined) {
                const el = this.currentElements.get(decision.element);
                if (el) {
                    // Convert element center from viewport to screenshot space
                    const scaleX = this.screenshotWidth / this.viewportWidth;
                    const scaleY = this.screenshotHeight / this.viewportHeight;
                    const cx = Math.round((el.x + el.width / 2) * scaleX);
                    const cy = Math.round((el.y + el.height / 2) * scaleY);
                    const armLen = 15;
                    const thickness = 3;

                    // Horizontal arm
                    for (let dx = -armLen; dx <= armLen; dx++) {
                        for (let dt = -Math.floor(thickness / 2); dt <= Math.floor(thickness / 2); dt++) {
                            const px = cx + dx;
                            const py = cy + dt;
                            if (px >= 0 && px < image.width && py >= 0 && py < image.height) {
                                image.setPixelColor(RED, px, py);
                            }
                        }
                    }
                    // Vertical arm
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

            const buffer = await image.getBuffer('image/jpeg', { quality: 85 });
            const agentTag = this.activeModel === 'specialist' ? 'spec_' : '';
            const filename = `turn_${String(this.decisionCount).padStart(3, '0')}_${agentTag}${decision.action}.jpg`;
            fs.writeFileSync(path.join(outputDir, filename), buffer);
        } catch (err) {
            // Non-critical — don't break the main loop
            console.warn(`  ⚠️ Debug screenshot save failed:`, err);
        }
    }

    // -----------------------------------------------------------------------
    // Utilities
    // -----------------------------------------------------------------------

    /** Parse JSON from LLM response, handling prose wrapper or markdown code blocks. */
    private parseJsonResponse(content: string): VisionAction {
        // Try direct parse first
        const trimmed = content.trim();
        try {
            return JSON.parse(trimmed) as VisionAction;
        } catch {
            // Fall through to extraction
        }

        // Try extracting JSON from markdown code block
        const codeBlockMatch = trimmed.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
        if (codeBlockMatch) {
            return JSON.parse(codeBlockMatch[1]) as VisionAction;
        }

        // Try extracting first JSON object from the text
        const jsonMatch = trimmed.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
            return JSON.parse(jsonMatch[0]) as VisionAction;
        }

        throw new SyntaxError(`No JSON found in response: ${trimmed.slice(0, 100)}`);
    }

    private delay(ms: number): Promise<void> {
        return new Promise(r => setTimeout(r, ms));
    }


    private formatAction(d: VisionAction): string {
        switch (d.action) {
            case 'click': return `click([${d.element}])`;
            case 'scroll': return `scroll(${d.direction || 'down'})`;
            case 'type': return `type("${(d.text || '').slice(0, 20)}")`;
            case 'press': return `press(${d.key})`;
            case 'hover': return `hover([${d.element}])`;
            case 'wait': return `wait(${d.seconds || 2}s)`;
            case 'newtab': return `newtab([${d.element}])`;
            case 'closetab': return 'closetab';
            case 'handoff': return 'handoff';
            case 'escalate': return 'escalate';
            case 'done': return 'done';
            default: return d.action;
        }
    }

    // Public getters for Kowalski session summary
    getRawScreenshotCount(): number { return this.rawCount; }
    getRecordCount(): number { return 0; }
    getDecisionCount(): number { return this.decisionCount; }
    getActionHistory(): ActionHistoryEntry[] { return [...this.actionHistory]; }
}
