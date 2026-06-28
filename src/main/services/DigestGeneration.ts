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
        const items = captures
            .map(toDigestItem)
            .filter((item): item is DigestItem => Boolean(item));
        const byHandle = new Map<string, DigestItem[]>();

        for (const item of items) {
            const key = item.handle || '@unknown';
            if (!byHandle.has(key)) byHandle.set(key, []);
            byHandle.get(key)!.push(item);
        }

        const ranked = [...byHandle.entries()]
            .map(([handle, groupItems]) => ({
                handle,
                items: groupItems,
                score: groupItems.reduce((sum, item) => sum + item.score, 0) + Math.min(groupItems.length, 4),
            }))
            .filter(group => group.handle !== '@unknown' && group.items.some(hasDigestSubstance))
            .sort((a, b) => b.score - a.score)
            .slice(0, 8);
        const topGroup = ranked[0];
        const topItem = topGroup?.items
            .slice()
            .sort((a, b) => b.score - a.score)[0];
        const topHeadline = headlineFromItem(topItem, topGroup?.handle) || 'Captured Highlights';
        const lines = [
            `# ${digestTitle(ranked)}`,
            '',
            `## ${emojiForHandle(topGroup?.handle)} Top Story: ${topHeadline}`,
            leadParagraph(topItem, topGroup?.handle),
        ];

        for (const group of ranked) {
            const summary = summarizeHandle(group.items);
            if (!summary) continue;
            lines.push('', `## ${emojiForHandle(group.handle)} ${group.handle}`, summary);
        }

        lines.push(
            '',
            '---',
            `*${storyCount} story frames and ${feedCount} posts reviewed across ${byHandle.size} accounts.${skippedCount > 0 ? ` ${skippedCount} captures were skipped.` : ''}*`
        );
        return lines.join('\n');
    }
}

interface DigestItem {
    handle: string | null;
    sentences: string[];
    facts: string[];
    score: number;
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

function toDigestItem(capture: CapturedPost): DigestItem | null {
    const extraction = capture.extraction;
    if (!extraction) return null;
    const sentences = uniqueStrings([
        ...splitIntoSentences(extraction.narrative),
        ...splitIntoSentences(extraction.caption),
        ...extraction.overlayText.flatMap(splitIntoSentences),
    ])
        .map(cleanText)
        .filter(isDigestSentence)
        .slice(0, 5);
    const facts = collectFactParts(extraction).slice(0, 8);
    const score = (
        usefulnessScore(extraction.usefulness) +
        Math.min(sentences.join(' ').length / 60, 4) +
        Math.min(facts.length, 5) +
        (capture.source === 'feed' ? 0.5 : 0)
    );
    return {
        handle: normalizeHandle(extraction.handle),
        sentences,
        facts,
        score,
    };
}

function usefulnessScore(usefulness: ExtractionBlock['usefulness']): number {
    if (usefulness === 'high') return 6;
    if (usefulness === 'medium') return 3;
    if (usefulness === 'low') return 1;
    return 0;
}

function hasDigestSubstance(item: DigestItem): boolean {
    return item.sentences.some(sentence => sentence.length >= 18) || item.facts.length >= 2;
}

function digestTitle(groups: Array<{ handle: string; items: DigestItem[] }>): string {
    const lead = groups[0];
    if (!lead) return 'Today';

    const event = bestEventLabel(lead.items);
    if (event) return titleCase(cleanHeadline(event));

    const topics = uniqueStrings(groups.flatMap(group => topicLabels(group.items, group.handle))).slice(0, 2);
    if (!topics.length) return 'Today';
    if (topics.length === 1) return titleCase(topics[0]);
    return `${titleCase(topics[0])} & ${titleCase(topics[1])}`;
}

function topicLabels(items: DigestItem[], handle: string): string[] {
    const factLabels = uniqueStrings(items.flatMap(item => item.facts))
        .filter(fact => !isAccountLike(fact))
        .filter(fact => !looksLikeNumericOnly(fact))
        .slice(0, 2);
    if (factLabels.length) return factLabels;
    return [humanizeHandle(handle)];
}

function headlineFromItem(item?: DigestItem, handle?: string): string | null {
    if (!item) return null;
    const event = bestEventLabel([item]);
    if (event) return titleCase(cleanHeadline(event));

    const sentence = bestSentence(item.sentences);
    if (sentence) return titleCase(cleanHeadline(truncate(sentence, 90)));

    const facts = item.facts.filter(fact => !isAccountLike(fact)).slice(0, 3);
    if (facts.length) return titleCase(cleanHeadline(facts.join(' ')));

    return handle ? humanizeHandle(handle) : null;
}

function leadParagraph(item?: DigestItem, handle?: string): string {
    if (!item) return 'The run captured usable Instagram content, but no single extraction was available for the lead item.';
    return paragraphFromItems([item], handle ?? item.handle, 3);
}

function summarizeHandle(items: DigestItem[]): string {
    return paragraphFromItems(items, items[0]?.handle, 3);
}

function paragraphFromItems(items: DigestItem[], handle: string | null | undefined, maxSentences: number): string {
    const sorted = items.slice().sort((a, b) => b.score - a.score);
    const facts = uniqueStrings(sorted.flatMap(item => item.facts)).filter(fact => !isAccountLike(fact));
    const keyFacts = chooseKeyFacts(facts, 3);
    const primaryFact = keyFacts[0] ?? null;
    const sentences = uniqueStrings(sorted.flatMap(item => item.sentences))
        .filter(sentence => !looksLikeStandaloneLabel(sentence))
        .filter(sentence => !isLowValuePromo(sentence))
        .slice(0, maxSentences);

    if (!sentences.length) {
        const fallbackFacts = facts.slice(0, 3);
        if (!fallbackFacts.length) return '';
        const subject = handle ? humanizeHandle(handle) : 'The account';
        return `${subject} centered the update on **${fallbackFacts[0]}**${fallbackFacts.length > 1 ? `, alongside ${fallbackFacts.slice(1).join(' and ')}` : ''}.`;
    }

    const paragraphSentences = sentences.map(sentence => ensureSentence(truncate(sentence, 220)));
    if (primaryFact) {
        const factIndex = paragraphSentences.findIndex(sentence => includesLoose(sentence, primaryFact));
        if (factIndex >= 0) {
            paragraphSentences[factIndex] = boldLooseMatch(paragraphSentences[factIndex], primaryFact);
        } else if (paragraphSentences.length < maxSentences) {
            paragraphSentences.push(`Other details included ${formatFactList(keyFacts)}.`);
        } else {
            paragraphSentences[paragraphSentences.length - 1] = appendKeyFact(paragraphSentences[paragraphSentences.length - 1], primaryFact);
        }
    }

    const missingFacts = keyFacts.filter(fact => !paragraphSentences.some(sentence => includesLoose(sentence, fact)));
    if (missingFacts.length && paragraphSentences.length < maxSentences) {
        paragraphSentences.push(`Other details included ${formatFactList(missingFacts)}.`);
    }

    return paragraphSentences.join(' ');
}

function splitIntoSentences(value?: string | null): string[] {
    const cleaned = cleanText(value);
    if (!cleaned || cleaned === '(no narrative produced)') return [];
    const parts = cleaned.split(/(?<=[.!?])\s+/);
    return parts
        .map(part => part.trim())
        .filter(Boolean);
}

function collectFactParts(extraction: ExtractionBlock): string[] {
    return uniqueStrings([
        ...extraction.entities.people,
        ...extraction.entities.teams,
        ...extraction.entities.products,
        ...extraction.entities.places,
        ...extraction.numbers,
        ...extraction.dates,
    ].map(cleanText))
        .filter(isUsefulFact)
        .slice(0, 12);
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

function cleanText(value?: string | null): string {
    if (!value) return '';
    return value
        .replace(/\s+/g, ' ')
        .replace(/^\[([^\]]+)\]\s*/, '$1: ')
        .replace(/\s+([,.;:!?])/g, '$1')
        .trim();
}

function cleanHeadline(value: string): string {
    return value
        .replace(/^["'“”]+|["'“”]+$/g, '')
        .replace(/[.!?]+$/g, '')
        .trim();
}

function isDigestSentence(value: string): boolean {
    const cleaned = cleanText(value);
    if (!cleaned) return false;
    if (/^a captured item that the extractor marked usable\.?$/i.test(cleaned)) return false;
    if (/^\(?no narrative produced\)?$/i.test(cleaned)) return false;
    if (/^\d+(?:\.\d+)?[KMB]?\s*(?:likes?|comments?|views?|shares?)?$/i.test(cleaned)) return false;
    return cleaned.length >= 8;
}

function isUsefulFact(value: string): boolean {
    const cleaned = cleanText(value);
    if (!cleaned) return false;
    if (/^\d+\s*(?:likes?|comments?|views?|shares?)$/i.test(cleaned)) return false;
    if (/^\d+(?:\.\d+)?[KMB]$/i.test(cleaned)) return false;
    if (/^\d+\s*[smhd]$/i.test(cleaned)) return false;
    if (/^\d+\s*(?:seconds?|minutes?|hours?|days?)\s*ago$/i.test(cleaned)) return false;
    if (/^0:\d{2}$/i.test(cleaned)) return false;
    if (/^\d+$/.test(cleaned)) return false;
    return true;
}

function chooseKeyFacts(facts: string[], max: number): string[] {
    return facts
        .filter(fact => !isAccountLike(fact))
        .sort((a, b) => factWeight(b) - factWeight(a))
        .slice(0, max);
}

function factWeight(fact: string): number {
    let score = 0;
    if (/\d/.test(fact)) score += 4;
    if (/\b(?:game|gp|fp\d|quali|qualifying|finals?|yards?|points?|ppg|laps?|round)\b/i.test(fact)) score += 3;
    if (/[A-Z][a-z]+ [A-Z][a-z]+/.test(fact)) score += 2;
    if (fact.length > 6 && fact.length < 40) score += 1;
    return score;
}

function bestEventLabel(items: DigestItem[]): string | null {
    const facts = uniqueStrings(items.flatMap(item => item.facts))
        .filter(fact => !isAccountLike(fact));
    const eventFact = facts.find(fact => /\b(?:austrian|monaco|barcelona|finals?|game \d+|gp|quali|qualifying|fp\d|summer league|world cup|media day)\b/i.test(fact));
    if (eventFact) return eventFact;

    const sentences = uniqueStrings(items.flatMap(item => item.sentences));
    const eventSentence = sentences.find(sentence => /\b(?:austrian|monaco|barcelona|finals?|game \d+|gp|quali|qualifying|fp\d|summer league|world cup|media day)\b/i.test(sentence));
    if (eventSentence) return headlineFragment(eventSentence);

    return null;
}

function bestSentence(sentences: string[]): string | null {
    return sentences
        .filter(sentence => !looksLikeStandaloneLabel(sentence))
        .sort((a, b) => sentenceWeight(b) - sentenceWeight(a))[0] ?? null;
}

function sentenceWeight(sentence: string): number {
    let score = Math.min(sentence.length / 20, 6);
    if (/\d/.test(sentence)) score += 3;
    if (/[A-Z][a-z]+ [A-Z][a-z]+/.test(sentence)) score += 2;
    if (/\b(?:sets?|leads?|wins?|falls?|acquired|lands|reaches|faces|qualifying|finals?|game|gp)\b/i.test(sentence)) score += 3;
    if (isLowValuePromo(sentence)) score -= 5;
    return score;
}

function headlineFragment(sentence: string): string {
    const cleaned = cleanHeadline(sentence)
        .replace(/^it'?s time for\s+/i, '')
        .replace(/^at\s+/i, '')
        .trim();
    const words = cleaned.split(/\s+/).slice(0, 8).join(' ');
    return words || cleaned;
}

function isLowValuePromo(value: string): boolean {
    return /\b(?:likes?|comments?|views?|shop now|link in bio|watch full reel|create because anything could happen)\b/i.test(value);
}

function isAccountLike(value: string): boolean {
    return value.startsWith('@') || (/^[a-z0-9._-]{2,}$/i.test(value) && value === value.toLowerCase() && !/\s/.test(value) && !/\d/.test(value));
}

function includesLoose(sentence: string, fact: string): boolean {
    return sentence.toLowerCase().includes(fact.toLowerCase());
}

function boldLooseMatch(sentence: string, fact: string): string {
    const escaped = fact.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return sentence.replace(new RegExp(escaped, 'i'), match => `**${match}**`);
}

function appendKeyFact(sentence: string, fact: string): string {
    return `${sentence.replace(/[.!?]$/, '')}, with **${fact}**.`;
}

function formatFactList(facts: string[]): string {
    const [first, ...rest] = facts;
    if (!first) return '';
    const boldedFirst = `**${first}**`;
    if (!rest.length) return boldedFirst;
    if (rest.length === 1) return `${boldedFirst} and ${rest[0]}`;
    return `${boldedFirst}, ${rest.slice(0, -1).join(', ')}, and ${rest[rest.length - 1]}`;
}

function looksLikeNumericOnly(value: string): boolean {
    return /^[\d\s:.,+-]+$/.test(value);
}

function looksLikeStandaloneLabel(value: string): boolean {
    const cleaned = value.replace(/[.!?]+$/g, '').trim();
    return cleaned.length < 18 && cleaned === cleaned.toUpperCase() && !/\d/.test(cleaned);
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

function humanizeHandle(handle: string): string {
    return titleCase(handle.replace(/^@/, '').replace(/[._-]+/g, ' '));
}

function emojiForHandle(handle?: string): string {
    const h = (handle ?? '').toLowerCase();
    if (/\b(?:nba|celtics|warriors|knicks|spurs)\b/.test(h)) return '🏀';
    if (/\b(?:nfl|patriots|football)\b/.test(h)) return '🏈';
    if (/\b(?:f1|mclaren|ferrari|mercedes|verstappen|formula)\b/.test(h)) return '🏁';
    if (/\b(?:fifa|worldcup|espnfc|soccer|football)\b/.test(h)) return '⚽';
    if (/\b(?:abcnews|news|cbssaturday)\b/.test(h)) return '📰';
    if (/\b(?:uofmichigan|pennstate)\b/.test(h)) return '🎓';
    return '📌';
}
