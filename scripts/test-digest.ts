import { DigestGeneration } from '../src/main/services/DigestGeneration.js';
import type { CapturedPost, ExtractionBlock } from '../src/types/instagram.js';

function assert(cond: unknown, message: string): asserts cond {
    if (!cond) throw new Error(message);
}

function extraction(overrides: Partial<ExtractionBlock>): ExtractionBlock {
    return {
        handle: '@nba',
        contentType: 'story',
        caption: null,
        overlayText: [],
        entities: {
            people: [],
            teams: ['Knicks', 'Spurs'],
            products: [],
            places: ['Madison Square Garden'],
        },
        numbers: ['Spurs 116', 'Knicks 111'],
        dates: ['Game 3'],
        narrative: 'Victor Wembanyama scored 32 points as the Spurs beat the Knicks in Game 3.',
        usefulness: 'high',
        skipReason: null,
        ...overrides,
    };
}

const captures: CapturedPost[] = [
    {
        id: 1,
        screenshot: Buffer.from('fake'),
        source: 'story',
        timestamp: Date.now(),
        scrollPosition: 0,
        extraction: extraction({}),
    },
    {
        id: 2,
        screenshot: Buffer.from('fake'),
        source: 'feed',
        timestamp: Date.now(),
        scrollPosition: 10,
        extraction: extraction({
            handle: '@uofmichigan',
            contentType: 'feed_post',
            entities: {
                people: [],
                teams: [],
                products: [],
                places: ['Ann Arbor'],
            },
            numbers: [],
            dates: [],
            narrative: 'Michigan welcomed campers to campus under cloudy skies.',
        }),
    },
    {
        id: 3,
        screenshot: Buffer.from('fake'),
        source: 'story',
        timestamp: Date.now(),
        scrollPosition: 20,
        extraction: extraction({
            usefulness: 'skip',
            skipReason: 'ad',
            narrative: 'Advertisement.',
        }),
    },
];

const generator = new DigestGeneration();
const result = await generator.generateDigest(captures, {
    userName: 'Smoke Tester',
    location: 'Localhost',
    scheduledTime: 'now',
});

assert(result.markdown.startsWith('# '), 'extractive digest should be markdown with a title');
assert(result.markdown.includes('Top Story'), 'extractive digest should include a top story');
assert(result.markdown.includes('@nba'), 'extractive digest should include grouped handles');
assert(result.markdown.includes('Spurs 116'), 'extractive digest should preserve extracted facts');
assert(!result.markdown.includes('led the captured run'), 'extractive digest should avoid generic captured-run phrasing');
assert(!result.markdown.includes('Notable details'), 'extractive digest should avoid raw detail dumps');
assert(!result.markdown.includes('LLM call failed'), 'extractive digest should not mention a failed LLM path');
assert(result.subtitle.includes('1 skipped'), 'analysis subtitle should count skipped captures');

const noisyResult = await generator.generateDigest([
    {
        id: 4,
        screenshot: Buffer.from('fake'),
        source: 'feed',
        timestamp: Date.now(),
        scrollPosition: 30,
        extraction: extraction({
            handle: '@instagram',
            contentType: 'feed_post',
            caption: 'create because anything could happen',
            overlayText: ['create because anything could happen'],
            entities: {
                people: [],
                teams: [],
                products: [],
                places: [],
            },
            numbers: ['225.8K', '72 likes', '57 likes'],
            dates: ['1d'],
            narrative: 'Instagram says create because anything could happen.',
            usefulness: 'medium',
        }),
    },
    {
        id: 5,
        screenshot: Buffer.from('fake'),
        source: 'story',
        timestamp: Date.now(),
        scrollPosition: 40,
        extraction: extraction({
            handle: '@f1',
            overlayText: ['[F1] Austrian GP'],
            entities: {
                people: ['Kimi Antonelli'],
                teams: ['Haas', 'Oracle Red Bull Racing'],
                products: [],
                places: [],
            },
            numbers: ['1:07.533'],
            dates: ['FP3', '16h'],
            narrative: 'Kimi Antonelli sets the pace at the halfway point with 1:07.533.',
            usefulness: 'high',
        }),
    },
], {
    userName: 'Smoke Tester',
    location: 'Localhost',
});

assert(noisyResult.markdown.includes('Kimi Antonelli'), 'digest should keep substantive named details');
assert(noisyResult.markdown.includes('1:07.533'), 'digest should keep substantive timing details');
assert(!noisyResult.markdown.includes('225.8K'), 'digest should filter bare social counters');
assert(!noisyResult.markdown.includes('72 likes'), 'digest should filter like counts');
assert(!noisyResult.markdown.includes('[F1]'), 'digest should clean bracket tags from headings/body');

console.log('✅ digest extractive writer test passed');
