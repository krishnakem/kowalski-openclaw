/**
 * FeedAgent - Phase 2: Feed browsing agent.
 *
 * The complex browsing agent. Uses Sonnet for reasoning about
 * which elements are timestamp links, how to handle carousels,
 * when to scroll, how to dismiss unexpected UI.
 *
 * Gets remaining time budget (total minus stories duration).
 * Reference images included (feed navigation is more complex).
 */

import { Page } from 'playwright';
import { GhostMouse } from './GhostMouse.js';
import { HumanScroll } from './HumanScroll.js';
import { ScreenshotCollector } from './ScreenshotCollector.js';
import { BaseVisionAgent, type BaseAgentConfig, type VisionAction } from './BaseVisionAgent.js';
import { ModelConfig } from '../../shared/modelConfig.js';
import feedInstructions from '../prompts/feed-instructions.md';

export class FeedAgent extends BaseVisionAgent {
    private visitedPostIds: Set<string> = new Set();
    private currentPostId: string | null = null;

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
        return feedInstructions;
    }

    protected getModel(): string {
        return ModelConfig.navigation;
    }

    protected getMaxTokens(): number {
        return 2048;
    }

    protected getReferenceImageFolder(): string | null {
        return 'feed';
    }

    protected getAgentName(): string {
        return 'FeedAgent';
    }

    protected shouldLabelElements(): boolean {
        return true; // Feed benefits from labeled elements for timestamp links, carousels, etc.
    }

    protected async executeAction(decision: VisionAction): Promise<string> {
        if (decision.action === 'click' && decision.element !== undefined) {
            const el = this.currentElements.get(decision.element);
            if (el?.href) {
                const postMatch = el.href.match(/\/p\/([^/]+)/);
                const reelMatch = el.href.match(/\/reel\/([^/]+)/);
                const postId = postMatch?.[1] || reelMatch?.[1];
                if (postId) {
                    this.currentPostId = postId;
                    console.log(`  📌 Viewing post: ${postId}`);
                    this.collector.appendLog(`📌 Viewing post: ${postId}`);
                }
            }
        }

        // When leaving a post, mark it as captured
        if (decision.action === 'goback' && this.currentPostId) {
            this.visitedPostIds.add(this.currentPostId);
            console.log(`  📌 Captured post: ${this.currentPostId} (${this.visitedPostIds.size} total)`);
            this.collector.appendLog(`📌 Captured post: ${this.currentPostId} (${this.visitedPostIds.size} total)`);
            this.currentPostId = null;
        }

        return super.executeAction(decision);
    }

    protected buildUserPrompt(remainingMs: number): string {
        let prompt = super.buildUserPrompt(remainingMs);
        if (this.visitedPostIds.size > 0) {
            prompt += `\n\nALREADY CAPTURED (skip these on the feed — do NOT click their timestamps again):\n${[...this.visitedPostIds].join(', ')}`;
        }
        return prompt;
    }

    protected getWorkflowSummary(): string {
        return `I've studied the reference images. Here's my workflow:

OPENING POSTS (from posts1):
- Find timestamp links (e.g. "13h", "2d", "7h") — these are the clickable text near the username
- Click the timestamp to open the post in a detail modal (dark overlay)
- Do NOT click the image or the username — only the timestamp link

POST MODAL (from posts2):
- The modal shows the post image on the left and caption/comments on the right
- Screenshot this view — this is the content I need to capture
- Ignore the "More posts from..." section below the modal (orange box area)
- Press Escape to close the modal and return to the feed

CAROUSELS (from posts3):
- Some posts have multiple images, indicated by a right arrow on the image and dot indicators below
- After opening the modal, if I see a right arrow: click it to advance to the next slide
- Screenshot each slide
- Repeat until the right arrow disappears (last slide)
- Then press Escape to return to feed

GOING HOME (from goinghome):
- If I get lost or need to reset, click the Instagram logo in the top-left corner of the sidebar
- This always returns me to the home feed`;
    }
}