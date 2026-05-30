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
import type { InferenceClient } from './Inference.js';
import { inferenceUsageToTokenUsage } from './Inference.js';

export class ImageTagger {
    private inferenceClient: InferenceClient;
    private userInterests: string[];
    private usageService: UsageService;

    constructor(inferenceClient: InferenceClient, userInterests: string[]) {
        this.inferenceClient = inferenceClient;
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

        try {
            const { tags, tokensUsed } = await this.tagIndividually(captures);

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

    private async tagIndividually(captures: CapturedPost[]): Promise<TaggingResult> {
        const tags: ImageTag[] = [];
        let tokensUsed = 0;

        for (let i = 0; i < captures.length; i++) {
            const imageId = i + 1;
            const prompt = this.buildTaggingPrompt(1).replace(/imageId": 1/g, `imageId": ${imageId}`);
            const result = await this.inferenceClient.complete({
                model: ModelConfig.tagging,
                prompt,
                images: [{ buffer: captures[i].screenshot, mime: 'image/jpeg', label: `image ${imageId}` }],
                maxTokens: 1024,
                purpose: 'Kowalski image tagging',
                expectJson: true,
            });
            if (result.usage) {
                tokensUsed += (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
                await this.usageService.incrementUsage(inferenceUsageToTokenUsage(result.usage));
            }
            const parsed = this.parseTaggingResponse(result.text, 1);
            const tag = parsed[0];
            if (tag) tags.push({ ...tag, imageId });
        }

        return { tags, tokensUsed };
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
