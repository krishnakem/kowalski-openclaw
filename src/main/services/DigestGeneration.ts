/**
 * DigestGeneration — Editorial Digest Writer (Text-Only)
 *
 * Composes a single markdown editorial column from per-image extractions written by
 * the Extractor agent. Does NOT re-send screenshots to the vision API — every visual
 * fact has already been extracted upstream into the sidecar JSON. The OpenClaw
 * gateway owns text model selection for this final synthesis call.
 */

import { CapturedPost, DigestConfig, ExtractionBlock } from '../../types/instagram.js';
import { AnalysisObject } from '../../types/analysis.js';
import { UsageService } from './UsageService.js';
import type { InferenceClient } from './Inference.js';
import { formatInferenceSource, inferenceUsageToTokenUsage } from './Inference.js';

export class DigestGeneration {
    private inferenceClient: InferenceClient;
    private usageService: UsageService;

    constructor(inferenceClient: InferenceClient) {
        this.inferenceClient = inferenceClient;
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

        const instructionPrompt = this.buildInstructionPrompt();
        const userPrompt = this.buildUserPrompt(usable, dayName, dateStr);

        console.log(`🤖 Generating digest from ${usable.length} extractions (${captures.length - usable.length} skipped)...`);

        const maxRetries = 4;
        let markdown = '';
        let lastError: unknown;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            // Bound each request at 60s — the digest can be large, but undici's
            // 5-minute default is far too long when connectivity drops.
            try {
                const result = await this.inferenceClient.complete({
                    systemPrompt: instructionPrompt,
                    prompt: userPrompt,
                    maxTokens: 4096,
                    signal: runSignal
                        ? AbortSignal.any([runSignal, AbortSignal.timeout(60_000)])
                        : AbortSignal.timeout(60_000),
                    timeoutMs: 60_000,
                    purpose: 'Kowalski digest generation',
                });

                if (result.usage) {
                    await this.usageService.incrementUsage(inferenceUsageToTokenUsage(result.usage));
                    const totalTokens = (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
                    console.log(`💰 Digest cost tracked: ${totalTokens} tokens`);
                }

                markdown = result.text.trim();
                if (!markdown) {
                    lastError = new Error(
                        `empty response from ${formatInferenceSource(result.provider, result.model)}`
                    );
                    if (attempt < maxRetries - 1) {
                        const delay = retryDelayMs(attempt, 3000, 15000);
                        console.warn(
                            `  ⏳ Digest LLM returned empty text (attempt ${attempt + 1}/${maxRetries}). Retrying in ${(delay / 1000).toFixed(1)}s...`
                        );
                        await new Promise(resolve => setTimeout(resolve, delay));
                        continue;
                    }
                }
                break;
            } catch (err) {
                lastError = err;
                const status = (err as { status?: number }).status;
                if (isRetryableDigestError(err) && attempt < maxRetries - 1) {
                    const baseDelay = status === 429 ? 10000 : 5000;
                    const delay = retryDelayMs(attempt, baseDelay, 60000);
                    console.warn(`  ⏳ Digest LLM retryable error (attempt ${attempt + 1}/${maxRetries}): ${errorSummary(err)}. Retrying in ${(delay / 1000).toFixed(1)}s...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }

                console.error('❌ Digest generation API error:', err);
                break;
            }
        }

        if (!markdown) {
            const reason = lastError instanceof Error ? lastError.message : String(lastError ?? 'unknown error');
            console.warn(`⚠️ Digest generation LLM unavailable; using extractive fallback (${reason})`);
            markdown = this.buildFallbackMarkdown(usable, captures.length - usable.length);
        }

        if (!markdown) {
            throw new Error('DIGEST_GENERATION_FAILED: No content in response');
        }

        return this.buildAnalysisObject(markdown, config, dayName, dateStr, captures, usable);
    }

    private buildInstructionPrompt(): string {
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

    private buildFallbackMarkdown(captures: CapturedPost[], skippedCount: number): string {
        const storyCount = captures.filter(c => c.source === 'story').length;
        const feedCount = captures.filter(c => c.source === 'feed').length;
        const byHandle = new Map<string, CapturedPost[]>();

        for (const capture of captures) {
            const handle = normalizeHandle(capture.extraction?.handle);
            const key = handle || '@unknown';
            if (!byHandle.has(key)) byHandle.set(key, []);
            byHandle.get(key)!.push(capture);
        }

        const ranked = [...byHandle.entries()]
            .sort((a, b) => b[1].length - a[1].length)
            .slice(0, 8);
        const topCapture = captures.find(c => c.extraction?.usefulness === 'high') ?? captures[0];
        const topHeadline = headlineFromCapture(topCapture) || 'Captured Highlights';
        const lines = [
            '# Today',
            '',
            `## 📰 Top Story: ${topHeadline}`,
            fallbackParagraph(topCapture),
        ];

        for (const [handle, items] of ranked) {
            if (handle === '@unknown') continue;
            const summary = summarizeHandle(items);
            if (!summary) continue;
            lines.push('', `## 📌 ${handle}`, summary);
        }

        lines.push(
            '',
            '---',
            `*${storyCount} story frames and ${feedCount} posts reviewed across ${byHandle.size} accounts.${skippedCount > 0 ? ` ${skippedCount} captures were skipped.` : ''}*`,
            '',
            '_Note: The digest writer LLM call failed, so this digest was assembled directly from extractor summaries._'
        );
        return lines.join('\n');
    }
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
}

function retryDelayMs(attempt: number, baseDelay: number, maxDelay: number): number {
    const backoff = Math.min(baseDelay * Math.pow(2, attempt), maxDelay);
    const jitter = backoff * 0.25 * (Math.random() * 2 - 1);
    return Math.max(250, Math.round(backoff + jitter));
}

function isRetryableDigestError(err: unknown): boolean {
    const status = (err as { status?: number } | null)?.status;
    if (status === 429 || status === 529 || (typeof status === 'number' && status >= 500)) {
        return true;
    }

    const summary = errorSummary(err).toLowerCase();
    return (
        summary.includes('connection error') ||
        summary.includes('invalid_provider_content_type') ||
        summary.includes('fetch failed') ||
        summary.includes('network') ||
        summary.includes('timeout')
    );
}

function errorSummary(err: unknown): string {
    if (err instanceof Error) {
        const cause = (err as Error & { cause?: unknown }).cause;
        return cause ? `${err.message} (${String(cause)})` : err.message;
    }
    return String(err);
}

function normalizeHandle(handle?: string | null): string | null {
    if (!handle) return null;
    const trimmed = handle.trim();
    if (!trimmed || trimmed === '?' || trimmed === '@unknown') return null;
    return trimmed.startsWith('@') ? trimmed.toLowerCase() : `@${trimmed.toLowerCase()}`;
}

function headlineFromCapture(capture?: CapturedPost): string | null {
    const extraction = capture?.extraction;
    if (!extraction) return null;
    const candidates = [
        extraction.overlayText.find(Boolean),
        extraction.narrative,
        extraction.caption,
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);
    const candidate = candidates[0]?.replace(/\s+/g, ' ').trim();
    if (!candidate) return null;
    return titleCase(truncate(candidate, 80).replace(/[.!?]+$/, ''));
}

function fallbackParagraph(capture?: CapturedPost): string {
    const extraction = capture?.extraction;
    if (!extraction) return 'The run captured usable Instagram content, but no single extraction was available for the lead item.';
    const facts = collectFacts(extraction);
    const handle = normalizeHandle(extraction.handle);
    const prefix = handle ? `${handle} led the captured run` : 'The captured run opened';
    return `${prefix} with ${sentenceFromExtraction(extraction)}${facts ? ` Key details: **${facts}**.` : ''}`;
}

function summarizeHandle(items: CapturedPost[]): string {
    const extractions = items
        .map(item => item.extraction)
        .filter((e): e is ExtractionBlock => Boolean(e));
    if (!extractions.length) return '';

    const narratives = uniqueStrings(extractions.map(sentenceFromExtraction)).slice(0, 3);
    const facts = uniqueStrings(extractions.flatMap(collectFactParts)).slice(0, 5);
    const body = narratives.join(' ');
    return facts.length ? `${body} Notable details: **${facts.join(' | ')}**.` : body;
}

function sentenceFromExtraction(extraction: ExtractionBlock): string {
    const narrative = extraction.narrative?.replace(/\s+/g, ' ').trim();
    if (narrative && narrative !== '(no narrative produced)') {
        return ensureSentence(truncate(narrative, 220));
    }
    const overlay = extraction.overlayText.find(Boolean);
    if (overlay) return ensureSentence(truncate(overlay, 180));
    if (extraction.caption) return ensureSentence(truncate(extraction.caption, 180));
    return 'a captured item that the extractor marked usable.';
}

function collectFacts(extraction: ExtractionBlock): string {
    return collectFactParts(extraction).slice(0, 4).join(' | ');
}

function collectFactParts(extraction: ExtractionBlock): string[] {
    return uniqueStrings([
        ...extraction.entities.people,
        ...extraction.entities.teams,
        ...extraction.numbers,
        ...extraction.dates,
    ]);
}

function uniqueStrings(values: Array<string | null | undefined>): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const value of values) {
        const cleaned = value?.replace(/\s+/g, ' ').trim();
        if (!cleaned) continue;
        const key = cleaned.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(cleaned);
    }
    return out;
}

function ensureSentence(text: string): string {
    const trimmed = text.trim();
    if (!trimmed) return '';
    return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function titleCase(text: string): string {
    return text
        .split(/\s+/)
        .map(word => word.length <= 3 && word === word.toUpperCase()
            ? word
            : `${word.charAt(0).toUpperCase()}${word.slice(1)}`)
        .join(' ');
}
