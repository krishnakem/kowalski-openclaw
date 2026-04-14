/**
 * ImageTagger - Smart Screenshot Selection via Batch Tagging
 *
 * Tags captured screenshots using LLM (see ModelConfig.tagging) to:
 * - Identify ads and sponsored content
 * - Filter out blank/loading screenshots
 * - Score relevance to user interests
 * - Score visual quality
 *
 * This enables capturing 50-60 screenshots and selecting the best 25
 * for digest generation, improving quality while managing token limits.
 *
 * Cost: ~$0.02 per batch (50-60 images at low detail)
 */

import { CapturedPost, ImageTag, TaggingResult } from '../../types/instagram.js';
import { UsageService } from './UsageService.js';
import { ModelConfig } from '../../shared/modelConfig.js';

/**
 * Internal type for image content in Anthropic API.
 */
interface ImageContent {
    type: 'image';
    source: {
        type: 'base64';
        media_type: string;
        data: string;
    };
}

/**
 * Internal type for text content in Anthropic API.
 */
interface TextContent {
    type: 'text';
    text: string;
}

export class ImageTagger {
    private apiKey: string;
    private userInterests: string[];
    private usageService: UsageService;

    constructor(apiKey: string, userInterests: string[]) {
        this.apiKey = apiKey;
        this.userInterests = userInterests;
        this.usageService = UsageService.getInstance();
    }

    /**
     * Batch-tag all captured images in a single API call.
     * Uses ModelConfig.tagging model.
     *
     * @param captures - Array of captured screenshots to tag
     * @returns TaggingResult with tags for each image and token usage
     */
    async tagBatch(captures: CapturedPost[]): Promise<TaggingResult> {
        if (captures.length === 0) {
            console.log('🏷️ No images to tag');
            return { tags: [], tokensUsed: 0 };
        }

        console.log(`🏷️ Tagging ${captures.length} images with ${ModelConfig.tagging}...`);

        // Build image content array
        const imageContents: ImageContent[] = captures.map((capture) => ({
            type: 'image' as const,
            source: {
                type: 'base64' as const,
                media_type: 'image/jpeg',
                data: capture.screenshot.toString('base64')
            }
        }));

        const prompt = this.buildTaggingPrompt(captures.length);

        // Build message content array
        const messageContent: (TextContent | ImageContent)[] = [
            { type: 'text', text: prompt },
            ...imageContents
        ];

        try {
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: ModelConfig.tagging,
                    messages: [{
                        role: 'user',
                        content: messageContent
                    }],
                    max_tokens: 4096
                })
            });

            if (!response.ok) {
                const errorData = await response.json().catch(() => ({}));
                console.error('❌ Tagging API error:', errorData);
                throw new Error('TAGGING_FAILED');
            }

            const data = await response.json();

            // Track usage
            const tokensUsed = (data.usage?.input_tokens || 0) + (data.usage?.output_tokens || 0);
            if (data.usage) {
                await this.usageService.incrementUsage(data.usage);
                console.log(`💰 Tagging cost tracked: ${tokensUsed} tokens`);
            }

            const contentBlocks = data.content as Array<{ type: string; text?: string }> | undefined;
            const content = contentBlocks?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('') || '';
            if (!content) {
                throw new Error('TAGGING_FAILED: No content in response');
            }

            const tags = this.parseTaggingResponse(content, captures.length);

            // Log summary
            const adCount = tags.filter(t => t.isAd).length;
            const blankCount = tags.filter(t => t.isBlank).length;
            const validCount = tags.filter(t => !t.isAd && !t.isBlank).length;

            console.log(`🏷️ Tagged ${tags.length} images:`);
            console.log(`   Ads: ${adCount}, Blank: ${blankCount}, Valid: ${validCount}`);

            return { tags, tokensUsed };

        } catch (error: any) {
            console.error('❌ Tagging failed:', error.message);

            // On failure, return empty tags - caller should fall back to using all images
            return { tags: [], tokensUsed: 0 };
        }
    }

    /**
     * Select the best N images based on tags.
     * Filters out ads and blank images, then sorts by relevance + quality.
     *
     * @param captures - Original captured screenshots
     * @param tags - Tags from tagBatch()
     * @param count - Maximum number of images to select (default 25)
     * @returns Selected captures in original chronological order
     */
    selectBest(captures: CapturedPost[], tags: ImageTag[], count: number = 25): CapturedPost[] {
        // If no tags (tagging failed), fall back to first N captures
        if (tags.length === 0) {
            console.log(`🏷️ No tags available, using first ${count} captures`);
            return captures.slice(0, count);
        }

        // Filter out blank images (ads remain — relevance scoring handles prioritization)
        const validTags = tags.filter(t => !t.isBlank);

        if (validTags.length === 0) {
            console.warn('🏷️ All images filtered (ads/blank), using original captures');
            return captures.slice(0, count);
        }

        // Sort by combined score (relevance weighted higher)
        const sorted = [...validTags].sort((a, b) => {
            const scoreA = a.relevance * 1.5 + a.quality;  // Weight relevance higher
            const scoreB = b.relevance * 1.5 + b.quality;
            return scoreB - scoreA;
        });

        // Take top N image IDs
        const selectedIds = new Set(sorted.slice(0, count).map(t => t.imageId));

        // Return captures in original order (preserves chronology for digest narrative)
        const selected = captures.filter(c => selectedIds.has(c.id));

        console.log(`🏷️ Selected ${selected.length} best images from ${captures.length} total`);

        // Log top 5 selections for debugging
        const topTags = sorted.slice(0, 5);
        console.log(`🏷️ Top selections:`);
        for (const tag of topTags) {
            console.log(`   #${tag.imageId}: relevance=${tag.relevance}, quality=${tag.quality} - ${tag.description.substring(0, 40)}...`);
        }

        return selected;
    }

    /**
     * Build the tagging prompt for the tagging model.
     */
    private buildTaggingPrompt(imageCount: number): string {
        const interests = this.userInterests.length > 0
            ? this.userInterests.join(', ')
            : 'general news and updates';

        return `You are analyzing ${imageCount} Instagram screenshots. For each image (numbered 1-${imageCount} in order), provide a brief tag.

USER INTERESTS: ${interests}

For each image, determine:
1. isAd: Is this sponsored content, an ad, or promotional material? (true/false)
2. isBlank: Is this a loading screen, blank, or unreadable? (true/false)
3. relevance: How relevant is this to the user's interests? (0-10, where 10 = directly matches interests)
4. quality: How clear and informative is this screenshot? (0-10, where 10 = perfect quality, readable text)
5. description: One brief sentence describing what's shown (max 50 chars)

DETECTION RULES:

Mark isAd=true for:
- Posts with "Sponsored" label visible
- Posts with "Paid partnership" label
- Product ads with "Shop Now", "Learn More" buttons
- Brand accounts with pricing/promotions
- Influencer sponsored content with disclaimers

Mark isBlank=true for:
- Loading spinners or skeleton UI
- Mostly empty/white screens
- Text too small or blurry to read
- Transition screens between content
- Error states

SCORING GUIDE:

relevance 8-10: Directly matches user interests (e.g., sports team they follow, local news)
relevance 5-7: Generally newsworthy or broadly interesting
relevance 2-4: Personal/lifestyle content, generic posts
relevance 0-1: Off-topic, irrelevant to most users

quality 8-10: Clear image, readable text, complete post visible
quality 5-7: Acceptable quality, some text readable
quality 2-4: Partial content visible, some blur
quality 0-1: Unreadable, severely cropped, or corrupted

Return JSON with this exact format:
{
    "tags": [
        {"imageId": 1, "isAd": false, "isBlank": false, "relevance": 8, "quality": 9, "description": "Cal Football recruiting news"},
        {"imageId": 2, "isAd": true, "isBlank": false, "relevance": 0, "quality": 7, "description": "Sponsored product ad"},
        {"imageId": 3, "isAd": false, "isBlank": true, "relevance": 0, "quality": 0, "description": "Loading screen"}
    ]
}

IMPORTANT: You must return a tag for EVERY image from 1 to ${imageCount}. Do not skip any.`;
    }

    /**
     * Parse the LLM response into ImageTag array.
     * Handles missing tags by filling with defaults.
     */
    private parseTaggingResponse(content: string, expectedCount: number): ImageTag[] {
        try {
            const parsed = JSON.parse(content);
            const rawTags: ImageTag[] = parsed.tags || [];

            // Build a map for quick lookup
            const tagMap = new Map<number, ImageTag>();
            for (const tag of rawTags) {
                if (typeof tag.imageId === 'number') {
                    tagMap.set(tag.imageId, tag);
                }
            }

            // Ensure we have a tag for every image
            const result: ImageTag[] = [];
            for (let i = 1; i <= expectedCount; i++) {
                const existing = tagMap.get(i);
                if (existing) {
                    // Validate and normalize the tag
                    result.push({
                        imageId: i,
                        isAd: Boolean(existing.isAd),
                        isBlank: Boolean(existing.isBlank),
                        relevance: Math.max(0, Math.min(10, Number(existing.relevance) || 0)),
                        quality: Math.max(0, Math.min(10, Number(existing.quality) || 0)),
                        description: String(existing.description || 'No description')
                    });
                } else {
                    // Default for missing tags - treat as low quality to deprioritize
                    console.warn(`🏷️ Missing tag for image #${i}, using default`);
                    result.push({
                        imageId: i,
                        isAd: false,
                        isBlank: false,  // Don't exclude, just give low score
                        relevance: 3,
                        quality: 3,
                        description: 'Tag missing from LLM response'
                    });
                }
            }

            return result;

        } catch (e) {
            console.error('❌ Failed to parse tagging response:', e);
            // Return empty array - caller should fall back to using all images
            return [];
        }
    }
}
