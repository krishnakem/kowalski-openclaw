/**
 * ContentVision - Stateless Vision API Content Extraction
 *
 * Uses Anthropic Messages API ONLY for content extraction (not navigation).
 * Each call is stateless - no conversation history maintained.
 *
 * Cost: varies by model (see ModelConfig.vision)
 *
 * Key principles:
 * - NO DOM fallback (bot-detectable)
 * - Skip & Continue on errors (don't halt session)
 * - Stateless calls (no conversation memory = lower cost)
 * - Exponential backoff on rate limits (avoid burst patterns)
 */

import { Page } from 'playwright';
import { ExtractedPost, ExtractionResult } from '../../types/instagram.js';
import { UsageService } from './UsageService.js';
import { ModelConfig } from '../../shared/modelConfig.js';

/**
 * Configuration for exponential backoff retry logic.
 */
interface BackoffConfig {
    maxRetries: number;
    baseDelayMs: number;
    maxDelayMs: number;
}

export class ContentVision {
    private apiKey: string;
    private usageService: UsageService;
    // NO conversationHistory - each call is stateless

    // Backoff configuration for rate limit handling
    // More resilient: 5 retries with 5s base delay (5s, 10s, 20s, 40s, 60s)
    private readonly backoffConfig: BackoffConfig = {
        maxRetries: 5,
        baseDelayMs: 5000,    // Start at 5 seconds (not 1s)
        maxDelayMs: 60000     // Cap at 60 seconds
    };

    constructor(apiKey: string) {
        this.apiKey = apiKey;
        this.usageService = UsageService.getInstance();
    }

    // =========================================================================
    // Exponential Backoff Logic (Prevents Burst Patterns)
    // =========================================================================

    /**
     * Calculate delay for exponential backoff with jitter.
     * Jitter prevents synchronized retry storms.
     *
     * With baseDelayMs=5000:
     * - Attempt 0: ~5s
     * - Attempt 1: ~10s
     * - Attempt 2: ~20s
     * - Attempt 3: ~40s
     * - Attempt 4: ~60s (capped)
     */
    private calculateBackoffDelay(attempt: number): number {
        // Exponential: 5s, 10s, 20s, 40s, 60s (capped)
        const exponentialDelay = this.backoffConfig.baseDelayMs * Math.pow(2, attempt);

        // Cap at max delay
        const cappedDelay = Math.min(exponentialDelay, this.backoffConfig.maxDelayMs);

        // Add jitter (±25% randomization)
        const jitter = cappedDelay * 0.25 * (Math.random() * 2 - 1);

        return Math.round(cappedDelay + jitter);
    }

    /**
     * Parse retry-after header value to milliseconds.
     * Handles both seconds (integer) and HTTP date formats.
     */
    private parseRetryAfterHeader(retryAfter: string | null): number | null {
        if (!retryAfter) return null;

        // Try parsing as seconds (e.g., "60")
        const seconds = parseInt(retryAfter, 10);
        if (!isNaN(seconds)) {
            return seconds * 1000;
        }

        // Try parsing as HTTP date (e.g., "Wed, 21 Oct 2015 07:28:00 GMT")
        const date = Date.parse(retryAfter);
        if (!isNaN(date)) {
            const delayMs = date - Date.now();
            return delayMs > 0 ? delayMs : null;
        }

        return null;
    }

    /**
     * Fetch with exponential backoff retry logic.
     * Handles rate limits gracefully without burst patterns.
     * Respects retry-after header when present.
     */
    private async fetchWithBackoff(
        url: string,
        options: RequestInit
    ): Promise<Response> {
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < this.backoffConfig.maxRetries; attempt++) {
            try {
                const response = await fetch(url, options);

                // Rate limit - apply backoff (respect retry-after header if present)
                if (response.status === 429) {
                    const retryAfterMs = this.parseRetryAfterHeader(response.headers.get('retry-after'));
                    const calculatedDelay = this.calculateBackoffDelay(attempt);

                    // Use retry-after if present and reasonable, otherwise use calculated delay
                    const delay = retryAfterMs && retryAfterMs <= this.backoffConfig.maxDelayMs * 2
                        ? retryAfterMs
                        : calculatedDelay;

                    console.log(`⏳ Rate limited (attempt ${attempt + 1}/${this.backoffConfig.maxRetries}). ` +
                        `${retryAfterMs ? `Server says wait ${retryAfterMs}ms. ` : ''}` +
                        `Backing off for ${delay}ms (${(delay / 1000).toFixed(1)}s)...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                // Server error (5xx) - also retry with backoff
                if (response.status >= 500) {
                    const delay = this.calculateBackoffDelay(attempt);
                    console.log(`⚠️ Server error ${response.status} (attempt ${attempt + 1}). Retrying in ${delay}ms (${(delay / 1000).toFixed(1)}s)...`);
                    await new Promise(r => setTimeout(r, delay));
                    continue;
                }

                // Success or client error (4xx) - return immediately
                return response;

            } catch (error: any) {
                // Network error - retry with backoff
                lastError = error;
                const delay = this.calculateBackoffDelay(attempt);
                console.log(`🔌 Network error (attempt ${attempt + 1}): ${error.message}. Retrying in ${delay}ms (${(delay / 1000).toFixed(1)}s)...`);
                await new Promise(r => setTimeout(r, delay));
            }
        }

        // All retries exhausted
        throw lastError || new Error('VISION_RATE_LIMITED');
    }

    /**
     * Extract visible posts from current viewport.
     * This is the ONLY function that calls the Vision API for feed content.
     *
     * Cost: ~$0.01 per call (one image + small text response)
     *
     * Error handling: Skip & Continue (no DOM fallback)
     */
    async extractVisibleContent(page: Page): Promise<ExtractionResult> {
        try {
            // 1. Capture viewport screenshot (JPEG for smaller size)
            const screenshot = await page.screenshot({
                fullPage: false,
                type: 'jpeg',
                quality: 80  // Reduce size to minimize API cost
            });

            const base64Image = screenshot.toString('base64');

            // 2. Calculate and log estimated cost
            const viewport = page.viewportSize();
            if (viewport) {
                const estimatedCost = this.usageService.calculateVisionCost(
                    viewport.width,
                    viewport.height,
                    'low'
                );
                console.log(`📸 Vision API: Estimated cost $${estimatedCost.toFixed(4)}`);
            }

            // 3. Single stateless Vision API call (with exponential backoff)
            const response = await this.fetchWithBackoff(
                'https://api.anthropic.com/v1/messages',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': this.apiKey,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: ModelConfig.vision,
                        messages: [{
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: `Extract all visible Instagram posts from this screenshot.

For each post, provide:
- username: The account that posted (include @ symbol)
- caption: The post caption/text (or empty string if none visible)
- contentType: "post", "story", or "reel"
- isVideoContent: true if this appears to be a video/reel (look for play button, reel icon, video progress bar)
- visualDescription: Brief description of images (SKIP this for videos - just note "Video content")

**Important for Videos/Reels:**
- If you see a play button overlay, reel icon, or video timeline → mark isVideoContent: true
- For videos, focus on extracting the USERNAME and any visible CAPTION only
- Do NOT try to describe video frames - they're unreliable

Return ONLY valid JSON. Example:
{"posts": [
  {"username": "@example", "caption": "Hello world!", "contentType": "post", "isVideoContent": false},
  {"username": "@creator", "caption": "Check out this reel!", "contentType": "reel", "isVideoContent": true}
]}

If no posts visible, return: {"posts": []}`
                                },
                                {
                                    type: 'image',
                                    source: {
                                        type: 'base64',
                                        media_type: 'image/jpeg',
                                        data: base64Image
                                    }
                                }
                            ]
                        }],
                        max_tokens: 16384
                    })
                }
            );

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));

                // Content policy violation - skip this viewport (NO DOM FALLBACK)
                if (errorData.error?.code === 'content_policy_violation') {
                    console.warn('⚠️ Vision API: Content policy violation - skipping viewport');
                    return {
                        success: false,
                        posts: [],
                        skipped: true,
                        reason: 'CONTENT_POLICY'
                    };
                }

                // Other API error - skip this viewport (rate limits handled by fetchWithBackoff)
                console.warn(`⚠️ Vision API error: ${errorData.error?.message || response.statusText} - skipping`);
                return {
                    success: false,
                    posts: [],
                    skipped: true,
                    reason: 'API_ERROR'
                };
            }

            const data = await response.json();

            // Track usage
            if (data.usage) {
                await this.usageService.incrementUsage(data.usage);
            }

            const contentBlocks = data.content as Array<{ type: string; text?: string }> | undefined;
            const content = contentBlocks?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || '';

            // 4. Parse response
            const parsed = JSON.parse(content);
            const posts = Array.isArray(parsed) ? parsed : (parsed.posts || []);

            return {
                success: true,
                posts: posts.map((p: any) => ({
                    username: p.username || 'unknown',
                    caption: p.caption || '',
                    contentType: p.contentType || 'post',
                    visualDescription: p.visualDescription,
                    isVideoContent: p.isVideoContent || false
                })),
                skipped: false
            };

        } catch (error: any) {
            // Rethrow rate limit error to halt session
            if (error.message === 'VISION_RATE_LIMITED') {
                throw error;
            }

            console.error('❌ Vision extraction failed:', error.message);

            // Network/timeout error - skip viewport (NO DOM FALLBACK)
            return {
                success: false,
                posts: [],
                skipped: true,
                reason: error.message
            };
        }
    }

    /**
     * Extract story content (simpler - usually just username + visual).
     */
    async extractStoryContent(page: Page): Promise<ExtractedPost | null> {
        try {
            const screenshot = await page.screenshot({
                fullPage: false,
                type: 'jpeg',
                quality: 70
            });

            const base64Image = screenshot.toString('base64');

            const response = await this.fetchWithBackoff(
                'https://api.anthropic.com/v1/messages',
                {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'x-api-key': this.apiKey,
                        'anthropic-version': '2023-06-01'
                    },
                    body: JSON.stringify({
                        model: ModelConfig.vision,
                        messages: [{
                            role: 'user',
                            content: [
                                {
                                    type: 'text',
                                    text: `Extract the Instagram story content:
- username: Story author (include @ symbol)
- caption: Any visible text on the story
- visualDescription: Brief description of what's shown

Return ONLY valid JSON: {"username": "", "caption": "", "visualDescription": ""}`
                                },
                                {
                                    type: 'image',
                                    source: {
                                        type: 'base64',
                                        media_type: 'image/jpeg',
                                        data: base64Image
                                    }
                                }
                            ]
                        }],
                        max_tokens: 16384
                    })
                }
            );

            if (!response.ok) {
                console.warn('⚠️ Story extraction failed:', response.statusText);
                return null;
            }

            const data = await response.json();

            // Track usage
            if (data.usage) {
                await this.usageService.incrementUsage(data.usage);
            }

            // Parse response, stripping any markdown code blocks if present
            const contentBlocks2 = data.content as Array<{ type: string; text?: string }> | undefined;
            let rawContent = contentBlocks2?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || '{}';
            if (!rawContent) rawContent = '{}';
            // Strip ```json ... ``` wrapper if present
            rawContent = rawContent.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '').trim();

            const content = JSON.parse(rawContent);

            return {
                username: content.username || 'unknown',
                caption: content.caption || '',
                contentType: 'story',
                visualDescription: content.visualDescription
            };
        } catch (error) {
            console.error('❌ Story extraction failed:', error);
            return null;
        }
    }

    /**
     * VIDEO RECORDING DISABLED — extractVideoContent() commented out
     */
    // async extractVideoContent(frames: Buffer[]): Promise<ExtractionResult> { ... }
}
