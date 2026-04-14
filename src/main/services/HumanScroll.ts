/**
 * HumanScroll - Scroll Control with CDP Helpers
 *
 * Direct single-call scrolling via page.mouse.wheel().
 * All multi-step physics (easing curves, micro-adjustments, variable delays)
 * have been removed.
 *
 * CDP helper methods are preserved for undetectable state queries:
 * - cdpEvaluate() — JS execution via CDP Runtime.evaluate
 * - getScrollPosition() / getScrollPositionX()
 * - isNearBottom()
 * - getViewportInfo()
 * - getNodeBoundingBoxByCDP()
 * - scrollToElementByCDP() / scrollToElementCentered()
 *
 * Cost: $0 (no API calls)
 *
 * IMPORTANT: NO DOM injection allowed.
 * - NO page.evaluate()
 * - NO page.$()
 * - All state queries use CDP Runtime.evaluate
 */

import { Page, CDPSession } from 'playwright';
import { ScrollConfig, BoundingBox, ContentType } from '../../types/instagram.js';

export class HumanScroll {
    private page: Page;

    constructor(page: Page) {
        this.page = page;
    }

    /** Rebind to a different page (used for tab switching). */
    setPage(page: Page): void {
        this.page = page;
    }

    // =========================================================================
    // CDP Helper Methods (Undetectable) — ALL KEPT
    // =========================================================================

    /**
     * Execute JavaScript via CDP Runtime.evaluate (undetectable).
     * This is different from page.evaluate() which injects scripts.
     */
    private async cdpEvaluate<T>(expression: string): Promise<T | null> {
        let cdpSession: CDPSession | null = null;
        try {
            cdpSession = await this.page.context().newCDPSession(this.page);
            const { result } = await cdpSession.send('Runtime.evaluate', {
                expression,
                returnByValue: true
            });
            return result.value as T;
        } catch {
            return null;
        } finally {
            if (cdpSession) {
                await cdpSession.detach().catch(() => {});
            }
        }
    }

    /**
     * Get bounding box for a node using CDP (undetectable).
     */
    private async getNodeBoundingBoxByCDP(
        cdpSession: CDPSession,
        backendNodeId: number
    ): Promise<BoundingBox | null> {
        try {
            const { model } = await cdpSession.send('DOM.getBoxModel', {
                backendNodeId
            });

            if (!model || !model.content) {
                return null;
            }

            const [x1, y1, x2, , , y3] = model.content;
            return {
                x: x1,
                y: y1,
                width: x2 - x1,
                height: y3 - y1
            };
        } catch {
            return null;
        }
    }

    // =========================================================================
    // Scroll Methods — simplified to single wheel calls
    // =========================================================================

    /**
     * Basic scroll. Single wheel call.
     */
    async scroll(config: ScrollConfig = {}): Promise<void> {
        const vh = await this.cdpEvaluate<number>('window.innerHeight') ?? 1920;
        const { baseDistance = Math.round(vh * 0.4) } = config;
        await this.page.mouse.wheel(0, baseDistance);
    }

    /**
     * Quick scroll for navigation. Single wheel call.
     */
    async quickScroll(distance: number): Promise<void> {
        await this.page.mouse.wheel(0, distance);
    }

    /**
     * Precise scroll for centering operations. Single wheel call.
     */
    async preciseScroll(distance: number): Promise<void> {
        await this.page.mouse.wheel(0, distance);
    }

    /**
     * Scroll to top of page.
     */
    async scrollToTop(): Promise<void> {
        const currentScroll = await this.cdpEvaluate<number>('window.scrollY');
        if (currentScroll && currentScroll > 0) {
            await this.page.mouse.wheel(0, -currentScroll);
        }
    }

    // =========================================================================
    // CDP State Queries — ALL KEPT
    // =========================================================================

    /**
     * Get current scroll position via CDP (undetectable).
     */
    async getScrollPosition(): Promise<number> {
        const scrollY = await this.cdpEvaluate<number>('window.scrollY');
        return scrollY ?? 0;
    }

    /**
     * Get current horizontal scroll position via CDP (undetectable).
     */
    async getScrollPositionX(): Promise<number> {
        const scrollX = await this.cdpEvaluate<number>('window.scrollX');
        return scrollX ?? 0;
    }

    /**
     * Check if we're near the bottom of the page via CDP (undetectable).
     */
    async isNearBottom(threshold?: number): Promise<boolean> {
        const vh = await this.cdpEvaluate<number>('window.innerHeight') ?? 1920;
        const effectiveThreshold = threshold ?? Math.round(vh * 0.2);
        const result = await this.cdpEvaluate<boolean>(`(function() {
            const scrollTop = window.scrollY;
            const scrollHeight = document.documentElement.scrollHeight;
            const clientHeight = window.innerHeight;
            return scrollTop + clientHeight >= scrollHeight - ${effectiveThreshold};
        })()`);
        return result ?? false;
    }

    /**
     * Get viewport dimensions via CDP (undetectable).
     */
    async getViewportInfo(): Promise<{ width: number; height: number; scrollHeight: number }> {
        const result = await this.cdpEvaluate<{ width: number; height: number; scrollHeight: number }>(`JSON.parse(JSON.stringify({
            width: window.innerWidth,
            height: window.innerHeight,
            scrollHeight: document.documentElement.scrollHeight
        }))`);
        return result ?? { width: 0, height: 0, scrollHeight: 0 };
    }

    // =========================================================================
    // Element Scrolling — CDP-based, simplified scroll calls
    // =========================================================================

    /**
     * Scroll to bring a specific element into view.
     * Uses CDP to get element position — NO DOM injection.
     */
    async scrollToElementByCDP(backendNodeId: number): Promise<boolean> {
        let cdpSession: CDPSession | null = null;
        try {
            cdpSession = await this.page.context().newCDPSession(this.page);

            const box = await this.getNodeBoundingBoxByCDP(cdpSession, backendNodeId);
            if (!box) return false;

            const viewportHeight = await this.cdpEvaluate<number>('window.innerHeight');
            if (viewportHeight === null) return false;

            // box.y is viewport-relative
            const elementCenter = box.y + box.height / 2;
            const viewportCenter = viewportHeight / 2;
            const scrollNeeded = elementCenter - viewportCenter;

            if (Math.abs(scrollNeeded) > viewportHeight * 0.05) {
                await this.page.mouse.wheel(0, scrollNeeded);
            }

            return true;
        } catch {
            return false;
        } finally {
            if (cdpSession) {
                await cdpSession.detach().catch(() => {});
            }
        }
    }

    /**
     * Scroll to center an element with verification and retry.
     * Fixed 50px tolerance (no variable tolerance needed without stealth).
     */
    async scrollToElementCentered(
        backendNodeId: number,
        maxRetries: number = 2
    ): Promise<{ success: boolean; finalOffset: number }> {
        const TOLERANCE = 50;

        for (let attempt = 0; attempt <= maxRetries; attempt++) {
            let cdpSession: CDPSession | null = null;
            try {
                cdpSession = await this.page.context().newCDPSession(this.page);

                const box = await this.getNodeBoundingBoxByCDP(cdpSession, backendNodeId);
                if (!box) {
                    return { success: false, finalOffset: Infinity };
                }

                const viewportHeight = await this.cdpEvaluate<number>('window.innerHeight');
                if (!viewportHeight) {
                    return { success: false, finalOffset: Infinity };
                }

                const elementCenterY = box.y + box.height / 2;
                const viewportCenterY = viewportHeight / 2;
                const offset = elementCenterY - viewportCenterY;

                if (Math.abs(offset) <= TOLERANCE) {
                    console.log(`  ✓ Post centered (offset: ${Math.round(offset)}px, attempt: ${attempt})`);
                    return { success: true, finalOffset: offset };
                }

                console.log(`  📍 Centering post (offset: ${Math.round(offset)}px, attempt: ${attempt + 1}/${maxRetries + 1})`);
                await this.page.mouse.wheel(0, offset);

                // Brief pause for scroll to settle
                await new Promise(r => setTimeout(r, 50));

            } finally {
                if (cdpSession) {
                    await cdpSession.detach().catch(() => {});
                }
            }
        }

        const finalOffset = await this.checkElementCenterOffset(backendNodeId);
        const success = Math.abs(finalOffset) <= TOLERANCE;

        if (!success) {
            console.log(`  ⚠️ Centering incomplete after ${maxRetries + 1} attempts (final offset: ${Math.round(finalOffset)}px)`);
        }

        return { success, finalOffset };
    }

    /**
     * Check how far an element is from viewport center.
     */
    private async checkElementCenterOffset(backendNodeId: number): Promise<number> {
        let cdpSession: CDPSession | null = null;
        try {
            cdpSession = await this.page.context().newCDPSession(this.page);
            const box = await this.getNodeBoundingBoxByCDP(cdpSession, backendNodeId);
            if (!box) return Infinity;

            const viewportHeight = await this.cdpEvaluate<number>('window.innerHeight');
            if (!viewportHeight) return Infinity;

            const elementCenterY = box.y + box.height / 2;
            const viewportCenterY = viewportHeight / 2;
            return elementCenterY - viewportCenterY;
        } finally {
            if (cdpSession) {
                await cdpSession.detach().catch(() => {});
            }
        }
    }

    // =========================================================================
    // Intent-Driven Scrolling — simplified, keeps failure detection
    // =========================================================================

    /**
     * Scroll with failure detection. Single wheel call.
     * The LLM decides scroll distance via config.baseDistance.
     */
    async scrollWithIntent(
        config: Partial<ScrollConfig> = {}
    ): Promise<{ contentType: ContentType; scrollDistance: number; actualDelta: number; scrollFailed: boolean; pauseDurationMs: number }> {
        const vh = await this.cdpEvaluate<number>('window.innerHeight') ?? 1920;
        const { baseDistance = Math.round(vh * 0.4) } = config;

        // Capture scroll position BEFORE (window + nested container)
        const scrollYBefore = await this.getScrollPosition();
        const scrollInfoBefore = await this.cdpEvaluate<{windowScrollY: number, mainScrollY: number, mainScrollHeight: number}>(`(function() {
            const main = document.querySelector('main') || document.querySelector('[role="main"]');
            return {
                windowScrollY: window.scrollY,
                mainScrollY: main ? main.scrollTop : -1,
                mainScrollHeight: main ? main.scrollHeight : -1
            };
        })()`);
        console.log('  📜 SCROLL DEBUG BEFORE:', JSON.stringify(scrollInfoBefore));

        // Single wheel call
        await this.page.mouse.wheel(0, baseDistance);

        // Small delay to let scroll settle
        await new Promise(r => setTimeout(r, 100));

        // Capture scroll position AFTER (window + nested container)
        const scrollYAfter = await this.getScrollPosition();
        const scrollInfoAfter = await this.cdpEvaluate<{windowScrollY: number, mainScrollY: number, mainScrollHeight: number}>(`(function() {
            const main = document.querySelector('main') || document.querySelector('[role="main"]');
            return {
                windowScrollY: window.scrollY,
                mainScrollY: main ? main.scrollTop : -1,
                mainScrollHeight: main ? main.scrollHeight : -1
            };
        })()`);
        console.log('  📜 SCROLL DEBUG AFTER:', JSON.stringify(scrollInfoAfter));

        const actualDelta = scrollYAfter - scrollYBefore;
        const mainDelta = (scrollInfoAfter?.mainScrollY ?? 0) - (scrollInfoBefore?.mainScrollY ?? 0);

        console.log(`  📜 SCROLL: Target=${baseDistance}px, window.scrollY delta=${actualDelta}px, main.scrollTop delta=${mainDelta}px`);

        // Scroll failure detection — check both window and nested container
        const effectiveDelta = actualDelta !== 0 ? actualDelta : mainDelta;
        let scrollFailed = false;
        if (effectiveDelta === 0 && Math.abs(baseDistance) > 50) {
            console.log('  ⚠️ Scroll Failed - Page may be stuck or reached bottom!');
            scrollFailed = true;
        }

        return {
            contentType: 'mixed',
            scrollDistance: baseDistance,
            actualDelta: effectiveDelta,
            scrollFailed,
            pauseDurationMs: 0
        };
    }

    /**
     * Horizontal scroll with failure detection. Single wheel call.
     */
    async scrollHorizontalWithIntent(
        config: Partial<ScrollConfig> = {}
    ): Promise<{ contentType: ContentType; scrollDistance: number; actualDelta: number; scrollFailed: boolean; pauseDurationMs: number }> {
        const vw = await this.cdpEvaluate<number>('window.innerWidth') ?? 1080;
        const { baseDistance = Math.round(vw * 0.4) } = config;

        const scrollXBefore = await this.getScrollPositionX();

        await this.page.mouse.wheel(baseDistance, 0);

        const scrollXAfter = await this.getScrollPositionX();
        const actualDelta = scrollXAfter - scrollXBefore;

        console.log(`  📜 H-SCROLL: Target=${baseDistance}px, Actual=${actualDelta}px`);

        let scrollFailed = false;
        if (actualDelta === 0 && Math.abs(baseDistance) > 50) {
            console.log('  ⚠️ Horizontal Scroll Failed');
            scrollFailed = true;
        }

        return {
            contentType: 'mixed',
            scrollDistance: baseDistance,
            actualDelta,
            scrollFailed,
            pauseDurationMs: 0
        };
    }
}