/**
 * Extractor — Async Vision-Based Content Extractor (Agent 2)
 *
 * Watches the raw/ directory for new screenshots dumped by the Navigator (Agent 1).
 * For each new screenshot, calls a vision LLM ONCE to extract structured content
 * (handle, captions, scores, entities, narrative). The result is merged into the
 * existing sidecar JSON in place — no copy, no separate filtered/ directory.
 *
 * The Digest writer (Agent 3) consumes these sidecars as text only, never re-sending
 * the images to a vision API. This means every screenshot is analyzed exactly once.
 *
 * Skip decisions (loading screens, ads, duplicates) are recorded as
 * `extraction.usefulness === 'skip'` rather than deleting anything — the digest can
 * still inspect the metadata, and you can audit what would have been culled.
 *
 * Completely decoupled from Agent 1 and Agent 3 — communicates via filesystem only.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ModelConfig } from '../../shared/modelConfig.js';
import { UsageService } from './UsageService.js';
import type { InferenceClient } from './Inference.js';
import { inferenceUsageToTokenUsage } from './Inference.js';
import { parseJsonObjectFromText } from './jsonResponse.js';
import { ExtractionBlock, ExtractionContentType, ExtractionUsefulness, ExtractionSkipReason } from '../../types/instagram.js';

export interface ExtractorStats {
    processed: number;
    extracted: number;       // Successfully extracted with usefulness != 'skip'
    skipped: number;         // Marked usefulness === 'skip'
    failed: number;          // Extraction call failed entirely
    tokensUsed: number;
}

const VALID_CONTENT_TYPES: ExtractionContentType[] = ['story', 'feed_post', 'story_ad', 'feed_ad', 'unreadable'];
const VALID_USEFULNESS: ExtractionUsefulness[] = ['high', 'medium', 'low', 'skip'];
const VALID_SKIP_REASONS: Exclude<ExtractionSkipReason, null>[] = [
    'loading_spinner', 'duplicate_frame', 'ad', 'blank', 'navigation_chrome', 'transitional'
];

export class Extractor {
    private rawDir: string;
    private inferenceClient: InferenceClient;
    private processed = new Set<string>();
    private running = false;
    private extracted = 0;
    private skipped = 0;
    private failed = 0;
    private tokensUsed = 0;
    private usageService: UsageService;
    private runSignal?: AbortSignal;

    constructor(rawDir: string, inferenceClient: InferenceClient, runSignal?: AbortSignal) {
        this.rawDir = rawDir;
        this.inferenceClient = inferenceClient;
        this.usageService = UsageService.getInstance();
        this.runSignal = runSignal;
    }

    /**
     * Start the async extractor loop. Polls raw/ for new screenshots every 2 seconds.
     * Resolves when the Navigator writes done.marker and all remaining files are processed.
     */
    async start(): Promise<ExtractorStats> {
        this.running = true;
        console.log(`🧠 Extractor: watching ${this.rawDir}`);

        while (this.running) {
            const files = fs.readdirSync(this.rawDir)
                .filter(f => f.endsWith('.jpg') && !this.processed.has(f))
                .sort();

            for (const file of files) {
                if (!this.running) break;
                await this.extractOne(file);
                this.processed.add(file);
            }

            if (fs.existsSync(path.join(this.rawDir, 'done.marker'))) {
                // Final sweep for files that arrived after our last check
                const remaining = fs.readdirSync(this.rawDir)
                    .filter(f => f.endsWith('.jpg') && !this.processed.has(f))
                    .sort();
                for (const file of remaining) {
                    await this.extractOne(file);
                    this.processed.add(file);
                }
                this.running = false;
                break;
            }

            await new Promise(resolve => setTimeout(resolve, 2000));
        }

        // Write our own done marker so downstream consumers know extraction finished
        fs.writeFileSync(path.join(this.rawDir, 'extracted.marker'), JSON.stringify({
            processed: this.processed.size,
            extracted: this.extracted,
            skipped: this.skipped,
            failed: this.failed,
            tokensUsed: this.tokensUsed,
            timestamp: Date.now()
        }));

        console.log(`🧠 Extractor: done. ${this.extracted} extracted, ${this.skipped} skipped, ${this.failed} failed out of ${this.processed.size} processed.`);

        return {
            processed: this.processed.size,
            extracted: this.extracted,
            skipped: this.skipped,
            failed: this.failed,
            tokensUsed: this.tokensUsed
        };
    }

    /** Stop the extractor loop early (e.g. user pressed Cmd+Shift+K). */
    stop(): void {
        this.running = false;
    }

    /**
     * Extract structured content from a single screenshot and merge into its sidecar.
     */
    private async extractOne(filename: string): Promise<void> {
        const filepath = path.join(this.rawDir, filename);
        const sidecarPath = path.join(this.rawDir, filename.replace('.jpg', '.json'));

        try {
            const buffer = fs.readFileSync(filepath);
            const extraction = await this.callExtractorLLM(buffer);

            // Merge into existing sidecar (preserving turn/phase/timestamp/agent fields)
            let sidecar: Record<string, unknown> = {};
            if (fs.existsSync(sidecarPath)) {
                try {
                    sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
                } catch {
                    sidecar = {};
                }
            }
            sidecar.extraction = extraction;
            fs.writeFileSync(sidecarPath, JSON.stringify(sidecar));

            if (extraction.usefulness === 'skip') {
                this.skipped++;
                console.log(`  🧠 ⊘ ${filename}: SKIP (${extraction.skipReason || 'unspecified'})`);
            } else {
                this.extracted++;
                const handle = extraction.handle || '?';
                const summary = extraction.narrative.length > 80
                    ? extraction.narrative.slice(0, 77) + '...'
                    : extraction.narrative;
                console.log(`  🧠 ✓ ${filename}: ${handle} — ${summary}`);
            }
        } catch (error) {
            // Fail open: write a minimal extraction block so downstream still sees the image
            this.failed++;
            console.warn(`  🧠 ⚠️ ${filename}: extraction failed —`, error);
            const fallback: ExtractionBlock = {
                handle: null,
                contentType: 'unreadable',
                caption: null,
                overlayText: [],
                entities: { people: [], teams: [], products: [], places: [] },
                numbers: [],
                dates: [],
                narrative: 'Extraction failed; image preserved on disk for manual review.',
                usefulness: 'low',
                skipReason: null
            };
            try {
                let sidecar: Record<string, unknown> = {};
                if (fs.existsSync(sidecarPath)) {
                    sidecar = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
                }
                sidecar.extraction = fallback;
                fs.writeFileSync(sidecarPath, JSON.stringify(sidecar));
            } catch {
                // Sidecar write failed too — give up on this image, continue the loop
            }
        }
    }

    /**
     * Call the vision LLM to extract structured content.
     * Uses the dedicated extraction model (Sonnet) — small overlay text demands fidelity.
     */
    private async callExtractorLLM(image: Buffer): Promise<ExtractionBlock> {
        const maxRetries = 4;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
            const attemptTimeout = AbortSignal.timeout(60_000);
            const signal = this.runSignal
                ? AbortSignal.any([this.runSignal, attemptTimeout])
                : attemptTimeout;

            try {
                const result = await this.inferenceClient.complete({
                    model: ModelConfig.extraction,
                    prompt: this.buildExtractionPrompt(),
                    images: [{ buffer: image, mime: 'image/jpeg', label: 'capture' }],
                    maxTokens: 800,
                    signal,
                    timeoutMs: 60_000,
                    purpose: 'Kowalski extraction',
                    expectJson: true,
                });

                if (result.usage) {
                    this.tokensUsed += (result.usage.inputTokens || 0) + (result.usage.outputTokens || 0);
                    this.usageService.incrementUsage(inferenceUsageToTokenUsage(result.usage));
                }

                return this.parseExtractionResponse(result.text);
            } catch (err) {
                // The run is shutting down intentionally (stop/timeout/offline
                // abort). Do not misclassify that as a transient network error
                // or retry with backoff.
                if (this.runSignal?.aborted) {
                    throw err;
                }
                const status = (err as { status?: number }).status;
                if ((status === 529 || status === 429) && attempt < maxRetries - 1) {
                    const baseDelay = status === 429 ? 10000 : 5000;
                    const backoff = Math.min(baseDelay * Math.pow(2, attempt), 60000);
                    const jitter = backoff * 0.25 * (Math.random() * 2 - 1);
                    const delay = Math.round(backoff + jitter);
                    console.warn(`  🧠 ⏳ Extractor LLM ${status} (attempt ${attempt + 1}/${maxRetries - 1}). Retrying in ${(delay / 1000).toFixed(1)}s...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                if (attempt < maxRetries - 1) {
                    const delay = 5000 * Math.pow(2, attempt);
                    const kind = err instanceof SyntaxError ? 'parse error' : 'provider error';
                    console.warn(`  🧠 ⏳ Extractor LLM ${kind} (attempt ${attempt + 1}/${maxRetries - 1}). Retrying in ${(delay / 1000).toFixed(1)}s...`);
                    await new Promise(resolve => setTimeout(resolve, delay));
                    continue;
                }
                throw err;
            }
        }

        throw new Error('Extractor LLM retries exhausted');
    }

    private parseExtractionResponse(text: string): ExtractionBlock {
        const raw = parseJsonObjectFromText<any>(text);
        return this.normalizeExtraction(raw);
    }

    private normalizeExtraction(raw: any): ExtractionBlock {
        const asString = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);
        const asStringArray = (v: unknown): string[] => Array.isArray(v)
            ? v.filter(x => typeof x === 'string' && x.trim()).map(x => (x as string).trim())
            : [];

        const contentType: ExtractionContentType = VALID_CONTENT_TYPES.includes(raw?.contentType)
            ? raw.contentType
            : 'unreadable';

        const usefulness: ExtractionUsefulness = VALID_USEFULNESS.includes(raw?.usefulness)
            ? raw.usefulness
            : 'low';

        let skipReason: ExtractionSkipReason = null;
        if (typeof raw?.skipReason === 'string' && (VALID_SKIP_REASONS as string[]).includes(raw.skipReason)) {
            skipReason = raw.skipReason as ExtractionSkipReason;
        }

        return {
            handle: asString(raw?.handle),
            contentType,
            caption: asString(raw?.caption),
            overlayText: asStringArray(raw?.overlayText),
            entities: {
                people: asStringArray(raw?.entities?.people),
                teams: asStringArray(raw?.entities?.teams),
                products: asStringArray(raw?.entities?.products),
                places: asStringArray(raw?.entities?.places)
            },
            numbers: asStringArray(raw?.numbers),
            dates: asStringArray(raw?.dates),
            narrative: asString(raw?.narrative) || '(no narrative produced)',
            usefulness,
            skipReason
        };
    }

    private buildExtractionPrompt(): string {
        return `You are the Kowalski Extractor. The screenshot below was captured during automated Instagram browsing. Extract the underlying content into a strict JSON object so a downstream writer can compose an editorial digest WITHOUT seeing the image.

══════════════════════════════════════════
ABSOLUTE RULES
══════════════════════════════════════════

1. VERBATIM ONLY for numbers, scores, handles, names, dates, prices, quotes. Never paraphrase a number, never round a score, never normalize a date format. Copy exactly what is on screen.
2. NEVER use meta-phrasings: "posted about", "shared a story about", "graphic showing", "image of", "screenshot of", "post about", "story about". Describe the underlying content, not the medium.
3. If you cannot read a value with confidence, OMIT it. Empty arrays and null fields are correct. Inventing is failure.
4. Caption text must be copied verbatim from the visible caption area only. Do NOT summarize a caption — copy it. If the caption is truncated on screen, copy what is visible and stop. If no caption is visible, set caption to null.
5. Handles must include the leading "@". Lowercase. If no handle is visible AND you cannot infer it from clear branding (team logo, watermark, "Warriors Instagram story"), set handle to null.

══════════════════════════════════════════
USEFULNESS DECISIONS
══════════════════════════════════════════

Set usefulness to "skip" with skipReason when the image is not real content:
  - "loading_spinner" — loading state, blank placeholder, partial render
  - "duplicate_frame" — looks like a near-duplicate of an adjacent capture (slight scroll, story progress tick)
  - "ad" — sponsored/promoted content (paid partnership tags, "Sponsored" labels, in-feed ads)
  - "blank" — empty home feed, dark overlay with nothing centered, mid-transition
  - "navigation_chrome" — search grid of tiny thumbnails, settings page, profile grid with no content focused, login screen
  - "transitional" — mid-scroll with no post focused, mid-swipe between stories

Otherwise set usefulness to "high", "medium", or "low":
  - "high" — clear, fact-rich post or story (named people, scores, scene, caption)
  - "medium" — readable content but lower fact density (vibe shots, partial info)
  - "low" — content is real but unclear handles/details; salvageable only with care

Even when usefulness is "skip", still fill narrative with a short literal description so the operator can audit decisions later.

══════════════════════════════════════════
OUTPUT — STRICT JSON, NO PROSE, NO CODE FENCES
══════════════════════════════════════════

{
  "handle": "@nba" | null,
  "contentType": "story" | "feed_post" | "story_ad" | "feed_ad" | "unreadable",
  "caption": "verbatim caption text" | null,
  "overlayText": ["verbatim overlay strings, one per visually distinct block"],
  "entities": {
    "people": ["LeBron James"],
    "teams": ["Lakers", "Warriors"],
    "products": [],
    "places": ["Chase Center"]
  },
  "numbers": ["118-112", "LeBron 34 pts", "10-22 FG"],
  "dates": ["Apr 12", "Saturday 8pm"],
  "narrative": "one short literal sentence. Use verbatim scores and names. No meta-phrasing.",
  "usefulness": "high" | "medium" | "low" | "skip",
  "skipReason": "loading_spinner" | "duplicate_frame" | "ad" | "blank" | "navigation_chrome" | "transitional" | null
}

Keep the JSON compact. Use at most 5 items per array. Return ONLY the JSON object. No explanation. No code fences.`;
    }
}
