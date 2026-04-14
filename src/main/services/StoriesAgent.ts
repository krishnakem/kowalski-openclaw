/**
 * StoriesAgent - Phase 1: Stories browsing agent.
 *
 * Bounded, mechanical, cheap. Uses Haiku for the tight loop of
 * click avatar → advance right → advance right → escape.
 *
 * No reference images needed (stories UI is simple).
 * Smaller max_tokens (512 is plenty for story navigation).
 * Hard time cap (default 3 minutes).
 */

import { Page } from 'playwright';
import { GhostMouse } from './GhostMouse.js';
import { HumanScroll } from './HumanScroll.js';
import { ScreenshotCollector } from './ScreenshotCollector.js';
import { BaseVisionAgent, type BaseAgentConfig, type VisionAction } from './BaseVisionAgent.js';
import { ModelConfig } from '../../shared/modelConfig.js';
import storiesInstructions from '../prompts/stories-instructions.md';

export class StoriesAgent extends BaseVisionAgent {
    constructor(
        page: Page,
        ghost: GhostMouse,
        scroll: HumanScroll,
        collector: ScreenshotCollector,
        config: BaseAgentConfig
    ) {
        super(page, ghost, scroll, collector, config);
    }

    protected getInstructionPrompt(): string {
        return storiesInstructions;
    }

    protected getModel(): string {
        return ModelConfig.stories;
    }

    protected getMaxTokens(): number {
        return 512;
    }

    protected getReferenceImageFolder(): string | null {
        return 'stories';
    }

    protected getAgentName(): string {
        return 'StoriesAgent';
    }

    protected shouldLabelElements(): boolean {
        return true;
    }

    protected async executeAction(decision: VisionAction): Promise<string> {
        const result = await super.executeAction(decision);

        // Auto-pause after actions that change the story frame
        const shouldAutoPause = (() => {
            if (decision.action === 'click' && decision.element !== undefined) {
                const el = this.currentElements.get(decision.element);
                if (el) {
                    const text = (el.text || el.ariaLabel || '').toLowerCase();
                    // Next/Previous navigation buttons
                    if (/^(next|previous)$/.test(text)) return true;
                    // Clicking a story avatar to open stories
                    if (el.ariaLabel?.toLowerCase().includes('story by')) return true;
                }
            }
            // Keep ArrowRight as fallback in case LLM still uses it
            if (decision.action === 'press' && decision.key === 'ArrowRight') return true;
            return false;
        })();

        if (shouldAutoPause) {
            const isAvatarClick = decision.element !== undefined &&
                (this.currentElements.get(decision.element)?.ariaLabel || '').toLowerCase().includes('story by');

            await this.delay(isAvatarClick ? 3000 : 1000);

            // Click the Pause button directly instead of pressing Space (avoids focus issues)
            const pauseClicked = await this.page.evaluate(() => {
                const buttons = Array.from(document.querySelectorAll('div[role="button"], button'));
                const pauseBtn = buttons.find(el => el.textContent?.trim() === 'Pause');
                if (pauseBtn) {
                    (pauseBtn as HTMLElement).click();
                    return true;
                }
                return false;
            }).catch(() => false);

            if (pauseClicked) {
                await this.delay(200);
                console.log('  ⏸️ Auto-pause: clicked Pause button');
                this.collector.appendLog('⏸️ Auto-pause: clicked Pause button');
            } else {
                // Fallback: try Space in case Pause button wasn't found
                await this.page.keyboard.press(' ');
                await this.delay(200);
                console.log('  ⏸️ Auto-pause: Pause button not found, used Space fallback');
                this.collector.appendLog('⏸️ Auto-pause: Pause button not found, used Space fallback');
            }

            // Story-end detection: only after ArrowRight, check if viewer closed
            if (decision.action === 'press' && decision.key === 'ArrowRight' ||
                (decision.action === 'click' && decision.element !== undefined &&
                 /^(next)$/i.test((this.currentElements.get(decision.element)?.text || this.currentElements.get(decision.element)?.ariaLabel || '').trim()))) {
                const storyViewerOpen = await this.page.evaluate(() => {
                    // Check for story-viewer-specific DOM elements
                    if (document.querySelector('[aria-label="Story viewer"]')) return true;
                    if (document.querySelector('[aria-label="Close"]')?.closest('[role="dialog"]')) return true;
                    // Progress bar segments at top of story viewer
                    const headers = document.querySelectorAll('header');
                    for (const h of headers) {
                        if (h.querySelectorAll('div[style*="width"]').length >= 2) return true;
                    }
                    return false;
                }).catch(() => false);

                const url = this.page.url();
                const onBaseFeed = /^https:\/\/www\.instagram\.com\/?(\?.*)?$/.test(url);

                if (!storyViewerOpen && onBaseFeed) {
                    console.log('  📖 StoriesAgent: story viewer closed — stories ended');
                    this.collector.appendLog('📖 StoriesAgent: story viewer closed — stories ended');
                    this.stopped = true;
                    return result;
                }
            }
        }

        return result;
    }

    protected async settleAfterAction(_decision: VisionAction): Promise<void> {
        this.lastActionWasContentCapture = true;
        await this.delay(300);
    }

    protected getWorkflowSummary(): string {
        return `I've studied the reference images. Here's my workflow:

OPENING STORIES (from stories1):
- Story avatars are the circular profile pictures at the top of the feed with colored gradient rings (pinkish-orange border)
- Click the LEFTMOST avatar with a gradient ring to start viewing stories
- The gradient ring distinguishes unwatched stories from regular profile pictures

VIEWING STORIES (from stories2):
- Press ArrowRight to advance to the next story frame
- Stories are automatically paused by the system — just keep pressing ArrowRight
- Do NOT click the small story previews on the sides (those are other users' stories)

EXITING STORIES (from stories.end):
- When I reach the last story (no more frames to advance to), click the X button in the top-right corner
- This exits the story viewer and returns to the home feed
- Do not skip any stories — every frame must be screenshotted`;
    }
}