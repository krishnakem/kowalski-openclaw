/**
 * DigestGeneration — Editorial Digest Writer (Text-Only)
 *
 * Composes a single markdown editorial column from per-image extractions written by
 * the Extractor agent. Does NOT re-send screenshots to the vision API — every visual
 * fact has already been extracted upstream into the sidecar JSON. This is what makes
 * the Haiku-default model viable.
 */

import { CapturedPost, DigestConfig, ExtractionBlock } from '../../types/instagram.js';
import { AnalysisObject } from '../../types/analysis.js';
import { ModelConfig } from '../../shared/modelConfig.js';
import { UsageService } from './UsageService.js';
import { isCreditsDepletedError, CREDITS_DEPLETED_ERROR } from './NetworkMonitor.js';

export class DigestGeneration {
    private apiKey: string;
    private usageService: UsageService;

    constructor(apiKey: string) {
        this.apiKey = apiKey;
        this.usageService = UsageService.getInstance();
    }

    async generateDigest(
        captures: CapturedPost[],
        config: DigestConfig,
        runSignal?: AbortSignal
    ): Promise<AnalysisObject> {
        if (captures.length === 0) {
            throw new Error('INSUFFICIENT_CONTENT: No screenshots captured');
        }

        const usable = captures.filter(c => {
            const u = c.extraction?.usefulness;
            return u !== 'skip';
        });

        if (usable.length === 0) {
            throw new Error('INSUFFICIENT_CONTENT: All captures were marked skip by the extractor');
        }

        const now = new Date();
        const dayName = now.toLocaleDateString('en-US', { weekday: 'long' });
        const dateStr = now.toLocaleDateString('en-US', {
            month: 'long',
            day: 'numeric',
            year: 'numeric'
        });

        const systemPrompt = this.buildSystemPrompt();
        const userPrompt = this.buildUserPrompt(usable, dayName, dateStr);

        console.log(`🤖 Generating digest from ${usable.length} extractions (${captures.length - usable.length} skipped)...`);

        const maxRetries = 4;
        let data: any;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            // Bound each request at 60s — the digest can be large, but undici's
            // 5-minute default is far too long when connectivity drops.
            const response = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'x-api-key': this.apiKey,
                    'anthropic-version': '2023-06-01'
                },
                body: JSON.stringify({
                    model: ModelConfig.digest,
                    system: systemPrompt,
                    messages: [{
                        role: 'user',
                        content: userPrompt
                    }],
                    max_tokens: 16384
                }),
                signal: runSignal
                    ? AbortSignal.any([runSignal, AbortSignal.timeout(60_000)])
                    : AbortSignal.timeout(60_000)
            });

            if ((response.status === 529 || response.status === 429) && attempt < maxRetries - 1) {
                const baseDelay = response.status === 429 ? 10000 : 5000;
                const backoff = Math.min(baseDelay * Math.pow(2, attempt), 60000);
                const jitter = backoff * 0.25 * (Math.random() * 2 - 1);
                const delay = Math.round(backoff + jitter);
                console.warn(`  ⏳ Digest LLM ${response.status} (attempt ${attempt + 1}/${maxRetries - 1}). Retrying in ${(delay / 1000).toFixed(1)}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
            }

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                console.error('❌ Digest generation API error:', errText.slice(0, 300));
                if (isCreditsDepletedError(response.status, errText)) {
                    throw new Error(CREDITS_DEPLETED_ERROR);
                }
                throw new Error('DIGEST_GENERATION_FAILED');
            }

            data = await response.json();
            break;
        }

        if (!data) {
            console.error('❌ Digest generation: all retries exhausted');
            throw new Error('DIGEST_GENERATION_FAILED');
        }

        if (data.usage) {
            await this.usageService.incrementUsage(data.usage);
            const totalTokens = (data.usage.input_tokens || 0) + (data.usage.output_tokens || 0);
            console.log(`💰 Digest cost tracked: ${totalTokens} tokens`);
        }

        const contentBlocks = data.content as Array<{ type: string; text?: string }> | undefined;
        const markdown = contentBlocks?.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim() || '';

        if (!markdown) {
            throw new Error('DIGEST_GENERATION_FAILED: No content in response');
        }

        return this.buildAnalysisObject(markdown, config, dayName, dateStr, captures, usable);
    }

    private buildSystemPrompt(): string {
        return `You are the Kowalski digest writer. You compose a single short markdown editorial column summarizing what happened on the Instagram accounts a reader follows. You write like a beat reporter filing a morning column — not a log parser, not a UI describer.

You receive STRUCTURED EXTRACTIONS, one per captured screenshot. Each extraction was written by an upstream vision agent and contains the handle, content type, caption, overlay text, named entities, verbatim numbers/scores, dates, and a literal narrative. Treat the extractions as ground truth. You do NOT see the images. Do not invent details that are not in the extractions.

══════════════════════════════════════════
VOICE
══════════════════════════════════════════

The reader wants to know what happened in the world their accounts cover, NOT what was on screen. Write prose, not captions.

══════════════════════════════════════════
CORE PRINCIPLES
══════════════════════════════════════════

1. SYNTHESIZE, DON'T ENUMERATE. Thirty-five frames of a single game become ONE paragraph about the game. Group every item by narrative first, then by account. Never emit one item per extraction.

2. LEAD WITH THE STORY, NOT THE FORMAT. Never reference the medium. Forbidden words and phrases:
   "graphic", "infographic", "story card", "story frame", "post modal", "visible", "clearly visible", "posted", "shared a post about", "was featured", "full-screen", "overlay", "screenshot", "frame showing", "extraction".
   Do not mention sponsor tags ("presented by Google", "presented by Chase", "presented by Advantant", "presented by DoorDash", "presented by PagerDuty", "presented by AWS") unless the sponsorship itself is the news.

3. BE SPECIFIC OR CUT IT. Every sentence must carry a name, number, score, date, or concrete fact pulled from the extraction. If the underlying data is vague or partial, CUT the item entirely rather than write around it.

4. NEVER SHOW DATA-QUALITY ARTIFACTS. No "@unknown", no "[unclear]", no "[team]", no raw turn numbers, no timestamps like "22h ago", no "Instagram", no image indices. If a handle didn't resolve from context, drop the item or fold it into a section whose ownership is obvious. The reader should never see scaffolding.

5. LEAD WITH THE BIGGEST STORY. Pick the single most consequential item of the day and make it a "Top Story" with a real headline. Everything else is a shorter section beneath it.

6. USE ACCOUNT NAMES AS SECTION HEADERS. Sections are like "## @nba", "## @warriors", "## @uofmichigan". Lowercase the handle. Never emit per-item "@unknown" labels.

══════════════════════════════════════════
TITLE GENERATION
══════════════════════════════════════════

Generate a short (2–5 words) editorial title that captures the day's dominant theme or mood. The title changes every run — it is NOT a fixed masthead. It should feel like a newspaper front-page banner or newsletter issue title.

Examples:
  - "Play-In Night" (Warriors-heavy Play-In day)
  - "Milestones & Margins" (milestone-heavy NBA day)
  - "Spring in Ann Arbor" (Michigan-heavy day)
  - "Quiet Monday" (slow news day)

Rules:
  - Do NOT use "The Kowalski Gazette", "Instagram Digest", "Daily Digest", or any generic brand-style title.
  - Do NOT include the date in the title — the UI renders the date/time/location subtitle automatically.
  - No clickbait. No puns. No exclamation marks.
  - Title case. No trailing punctuation.
  - If nothing confident to title around, fall back to a neutral one-word title (e.g., "Today").

══════════════════════════════════════════
REQUIRED MARKDOWN STRUCTURE
══════════════════════════════════════════

Output exactly this structure — no preamble, no JSON, no code fences, no commentary. Just the markdown:

# [Generated Title]

## [emoji] Top Story: [Headline]
[2–4 sentence paragraph. Name key players, scores, and turning points in narrative order. End with a forward-looking hook if relevant.]

## [emoji] @[account]
[Prose paragraph, 2–3 sentences. Fold related items together. Bold the single most quotable fact with **double asterisks**.]

## [emoji] @[next account]
[Same treatment.]

---
*[N] story frames and [M] posts reviewed across [K] accounts.*

══════════════════════════════════════════
DO
══════════════════════════════════════════

- Short declarative leads: "The Warriors' night at Chase Center went the distance and came up short, falling 110–115 to the Clippers."
- Sequence scoreboard moments: "Seth Curry beat the first-quarter buzzer, Brandin Podziemski beat the second, and the Warriors still walked into the locker room trailing 48–52."
- Milestones as milestones: "Cooper Flagg leads the 2025–26 rookie scoring race at 21.0 PPG."
- Bold the single number, name, or date per paragraph that matters most.
- Dates in natural English: "Saturday, April 18 at 2 PM" not "2026-04-18T14:00".

══════════════════════════════════════════
DON'T
══════════════════════════════════════════

- List standings table-style unless the standings themselves are the news. If you must, name the top 3–5 teams in prose; never dump all 15.
- Include sponsor disclosures, ad frames, or League Pass tune-in copy.
- Write paragraphs longer than ~4 sentences per section.
- Use "graphic", "infographic", or any format-describing noun.
- Invent. If the data is ambiguous, cut the item.

══════════════════════════════════════════
THE "WOULD A SPORTSWRITER WRITE THIS?" TEST
══════════════════════════════════════════

Before any sentence ships, ask: would this appear in a newspaper sports section? If it reads like an extraction caption, a CMS field, or a debug log — rewrite or cut.

══════════════════════════════════════════
HANDLE RESOLUTION
══════════════════════════════════════════

Each extraction has a handle field, but it may be null. Resolve ownership from context:
  - Warriors team imagery, Starting Five lineup, or Chase Center scoreboard belongs to @warriors.
  - "NBA Spain" → @nbaspain. "NBA Indonesia" → @nbaindonesia.
  - Generic NBA branding belongs to @nba.
  - Michigan campus content or "uofmichigan" mentions belong to @uofmichigan.
If you genuinely cannot place an item with confidence, drop it.

══════════════════════════════════════════
OUTPUT
══════════════════════════════════════════

Return ONLY the markdown document. Begin immediately with "# " and the generated title. No JSON, no code fences, no preamble.`;
    }

    private renderExtraction(c: CapturedPost, index: number): string {
        const e: ExtractionBlock | undefined = c.extraction;
        if (!e) {
            return `[${index + 1}] (no extraction available — image preserved on disk only)`;
        }

        const lines: string[] = [];
        const handle = e.handle || '?';
        lines.push(`[${index + 1}] ${handle} | ${e.contentType} | usefulness=${e.usefulness}`);

        if (e.caption) lines.push(`  caption: ${truncate(e.caption, 400)}`);
        if (e.overlayText.length) lines.push(`  overlay: ${e.overlayText.map(s => `"${s}"`).join(' | ')}`);

        const ent = e.entities;
        const entityParts: string[] = [];
        if (ent.people.length) entityParts.push(`people=${ent.people.join(', ')}`);
        if (ent.teams.length) entityParts.push(`teams=${ent.teams.join(', ')}`);
        if (ent.places.length) entityParts.push(`places=${ent.places.join(', ')}`);
        if (ent.products.length) entityParts.push(`products=${ent.products.join(', ')}`);
        if (entityParts.length) lines.push(`  entities: ${entityParts.join(' | ')}`);

        if (e.numbers.length) lines.push(`  numbers: ${e.numbers.join(' | ')}`);
        if (e.dates.length) lines.push(`  dates: ${e.dates.join(' | ')}`);
        lines.push(`  narrative: ${e.narrative}`);

        return lines.join('\n');
    }

    private buildUserPrompt(
        captures: CapturedPost[],
        dayName: string,
        dateStr: string
    ): string {
        const feedItems = captures.filter(c => c.source === 'feed');
        const storyItems = captures.filter(c => c.source === 'story');
        // Profile/carousel sources, if any, fall in with feed for prompt purposes.
        const otherItems = captures.filter(c => c.source !== 'feed' && c.source !== 'story');

        const feedCount = feedItems.length;
        const storyCount = storyItems.length;

        const storiesBlock = storyItems.length
            ? storyItems.map((c, i) => this.renderExtraction(c, i)).join('\n\n')
            : '(none)';
        const feedBlock = feedItems.length
            ? feedItems.map((c, i) => this.renderExtraction(c, i)).join('\n\n')
            : '(none)';
        const otherBlock = otherItems.length
            ? `\n══════════════════════════════════════════\nOTHER (${otherItems.length} total)\n══════════════════════════════════════════\n${otherItems.map((c, i) => this.renderExtraction(c, i)).join('\n\n')}\n`
            : '';

        return `Today is ${dayName}, ${dateStr}.

You have ${captures.length} usable Instagram extractions from this morning's run: ${storyCount} story frames and ${feedCount} feed posts.${otherItems.length ? ` (${otherItems.length} additional items.)` : ''}

Each block below was written by the upstream Extractor — the only source of truth about what was on screen. Quote numbers, scores, names, and dates verbatim from these extractions. Do not invent details that are not present.

══════════════════════════════════════════
STORY FRAMES (chronological, ${storyCount} total)
══════════════════════════════════════════
${storiesBlock}

══════════════════════════════════════════
FEED POSTS (chronological, ${feedCount} total)
══════════════════════════════════════════
${feedBlock}
${otherBlock}
Now write the editorial column. Begin immediately with "# " followed by your generated title. No preamble.`;
    }

    private buildAnalysisObject(
        markdown: string,
        config: DigestConfig,
        _dayName: string,
        _dateStr: string,
        allCaptures: CapturedPost[],
        usableCaptures: CapturedPost[]
    ): AnalysisObject {
        const cleaned = this.stripCodeFences(markdown).trim();

        const titleMatch = cleaned.match(/^#\s+(.+?)\s*$/m);
        const title = titleMatch?.[1]?.trim() || 'Today';

        const storyCount = usableCaptures.filter(c => c.source === 'story').length;
        const feedCount = usableCaptures.filter(c => c.source === 'feed').length;
        const skippedCount = allCaptures.length - usableCaptures.length;
        const subtitle = skippedCount > 0
            ? `${storyCount} story frames and ${feedCount} posts reviewed (${skippedCount} skipped)`
            : `${storyCount} story frames and ${feedCount} posts reviewed`;

        console.log(`✅ Digest generated: "${title}"`);

        return {
            title,
            subtitle,
            markdown: cleaned,
            sections: [], // legacy field; renderer prefers `markdown`
            date: new Date().toISOString(),
            location: config.location || '',
            scheduledTime: new Date().toLocaleTimeString('en-US', {
                hour: 'numeric',
                minute: '2-digit',
                hour12: true
            })
        };
    }

    private stripCodeFences(text: string): string {
        const fenceMatch = text.match(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```\s*$/);
        return fenceMatch ? fenceMatch[1] : text;
    }
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}
