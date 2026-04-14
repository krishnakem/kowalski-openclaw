/**
 * GhostMouse - Direct Mouse Control
 *
 * Wraps Playwright mouse API with a consistent interface.
 * All movement physics (Bezier curves, jitter, overshoot) have been removed.
 * Uses direct page.mouse.move() and page.mouse.click() calls.
 *
 * Cost: $0 (no API calls)
 */

import { Page } from 'playwright';
import { Point, BoundingBox } from '../../types/instagram.js';

export class GhostMouse {
    private page: Page;
    private currentPosition: Point = { x: 0, y: 0 };

    constructor(page: Page) {
        this.page = page;
    }

    /** Rebind to a different page (used for tab switching). */
    setPage(page: Page): void {
        this.page = page;
    }

    /**
     * Move mouse to target point.
     */
    async moveTo(target: Point): Promise<void> {
        await this.page.mouse.move(target.x, target.y);
        this.currentPosition = target;
    }

    /**
     * Click at a target point.
     */
    async click(target: Point): Promise<void> {
        await this.page.mouse.click(target.x, target.y);
        this.currentPosition = target;
    }

    /**
     * Click at specific coordinates.
     * Used by VisionAgent where coordinates come from LLM vision.
     */
    async clickPoint(x: number, y: number): Promise<void> {
        await this.page.mouse.click(x, y);
        this.currentPosition = { x, y };
    }

    /**
     * Hover over a target for a duration without clicking.
     */
    async hover(target: Point, durationMs: number = 1000): Promise<void> {
        await this.page.mouse.move(target.x, target.y);
        this.currentPosition = target;
        if (durationMs > 0) {
            await new Promise(resolve => setTimeout(resolve, durationMs));
        }
    }

    /**
     * Click the center of an element's bounding box.
     */
    async clickElement(boundingBox: BoundingBox): Promise<void> {
        const cx = boundingBox.x + boundingBox.width / 2;
        const cy = boundingBox.y + boundingBox.height / 2;
        await this.page.mouse.click(cx, cy);
        this.currentPosition = { x: cx, y: cy };
    }

    /**
     * Hover over the center of an element's bounding box.
     */
    async hoverElement(boundingBox: BoundingBox, durationMs: number = 1000): Promise<void> {
        const cx = boundingBox.x + boundingBox.width / 2;
        const cy = boundingBox.y + boundingBox.height / 2;
        await this.hover({ x: cx, y: cy }, durationMs);
    }

    /**
     * Click at a target point (role parameter ignored — kept for API compat).
     */
    async clickWithRole(target: Point, _role?: string): Promise<void> {
        await this.click(target);
    }

    /**
     * Click the center of an element (role parameter ignored — kept for API compat).
     */
    async clickElementWithRole(boundingBox: BoundingBox, _role?: string): Promise<void> {
        await this.clickElement(boundingBox);
    }

    /**
     * Get hover duration for a role. Returns a fixed small value.
     * Kept for API compatibility.
     */
    getHoverDurationForRole(_role: string): number {
        return 100;
    }
}