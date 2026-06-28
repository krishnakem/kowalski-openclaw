/**
 * DigestGeneration — Extractive Digest Writer (Text-Only)
 *
 * Composes markdown directly from per-image extractions written by the
 * Extractor agent. Does NOT call a final text LLM and does NOT re-send
 * screenshots to a vision API — every visual fact has already been extracted
 * upstream into the sidecar JSON.
 */

import { CapturedPost, DigestConfig, ExtractionBlock } from '../../types/instagram.js';
import { AnalysisObject } from '../../types/analysis.js';

export class DigestGeneration {
    async generateDigest(
        captures: CapturedPost[],
        config: DigestConfig,
        _runSignal?: AbortSignal
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

        console.log(`🧾 Assembling digest from ${usable.length} extractions (${captures.length - usable.length} skipped)...`);
        const markdown = this.buildExtractiveMarkdown(usable, captures.length - usable.length);

        if (!markdown) {
            throw new Error('DIGEST_GENERATION_FAILED: No content in response');
        }

        return this.buildAnalysisObject(markdown, config, dayName, dateStr, captures, usable);
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

    private buildExtractiveMarkdown(captures: CapturedPost[], skippedCount: number): string {
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
            leadParagraph(topCapture),
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
            `*${storyCount} story frames and ${feedCount} posts reviewed across ${byHandle.size} accounts.${skippedCount > 0 ? ` ${skippedCount} captures were skipped.` : ''}*`
        );
        return lines.join('\n');
    }
}

function truncate(s: string, max: number): string {
    if (s.length <= max) return s;
    return s.slice(0, max - 1) + '…';
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

function leadParagraph(capture?: CapturedPost): string {
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
