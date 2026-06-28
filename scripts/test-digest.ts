import { DigestGeneration } from '../src/main/services/DigestGeneration.js';
import type { CapturedPost, ExtractionBlock } from '../src/types/instagram.js';
import type { InferenceClient, InferenceRequest } from '../src/main/services/Inference.js';

function assert(cond: unknown, message: string): asserts cond {
    if (!cond) throw new Error(message);
}

const failingInference: InferenceClient = {
    backend: 'openclaw',
    complete: async () => {
        throw new Error('simulated OpenClaw text transport failure');
    },
};

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

const generator = new DigestGeneration(failingInference);
const result = await generator.generateDigest(captures, {
    userName: 'Smoke Tester',
    location: 'Localhost',
    scheduledTime: 'now',
});

assert(result.markdown.startsWith('# '), 'fallback digest should be markdown with a title');
assert(result.markdown.includes('Top Story'), 'fallback digest should include a top story');
assert(result.markdown.includes('@nba'), 'fallback digest should include grouped handles');
assert(result.markdown.includes('Spurs 116'), 'fallback digest should preserve extracted facts');
assert(result.markdown.includes('digest writer LLM call failed'), 'fallback digest should disclose fallback mode');
assert(result.subtitle.includes('1 skipped'), 'analysis subtitle should count skipped captures');

console.log('✅ digest fallback test passed');

let capturedRequest: InferenceRequest | null = null;
const successfulInference: InferenceClient = {
    backend: 'openclaw',
    complete: async (request) => {
        capturedRequest = request;
        return {
            text: '# Model Digest\n\n## 📰 Top Story: Host Model Worked\nThe host model produced markdown.',
            provider: 'openclaw-host',
            model: 'host-selected',
            usage: { inputTokens: 10, outputTokens: 5 },
        };
    },
};

const successfulGenerator = new DigestGeneration(successfulInference);
const successfulResult = await successfulGenerator.generateDigest(captures, {
    userName: 'Smoke Tester',
    location: 'Localhost',
    scheduledTime: 'now',
});

assert(successfulResult.title === 'Model Digest', 'successful digest should use host model markdown');
assert(capturedRequest !== null, 'successful digest should call inference');
assert(capturedRequest.model === undefined, 'digest generation must not choose a model');
assert(capturedRequest.systemPrompt === undefined, 'digest generation should not use a separate systemPrompt');
assert(
    typeof capturedRequest.prompt === 'string' && capturedRequest.prompt.includes('You are the Kowalski digest writer.'),
    'digest instructions should be included in the user prompt'
);

console.log('✅ digest host-model request-shape test passed');

let emptyThenSuccessCalls = 0;
const emptyThenSuccessInference: InferenceClient = {
    backend: 'openclaw',
    complete: async () => {
        emptyThenSuccessCalls += 1;
        if (emptyThenSuccessCalls === 1) {
            return {
                text: '',
                provider: 'openclaw-host',
                model: 'host-selected',
                usage: { inputTokens: 10, outputTokens: 0 },
            };
        }
        return {
            text: '# Retry Worked\n\n## 📰 Top Story: Second Call\nThe retry produced markdown.',
            provider: 'openclaw-host',
            model: 'host-selected',
            usage: { inputTokens: 10, outputTokens: 5 },
        };
    },
};

const retryGenerator = new DigestGeneration(emptyThenSuccessInference);
const retryResult = await retryGenerator.generateDigest(captures, {
    userName: 'Smoke Tester',
    location: 'Localhost',
    scheduledTime: 'now',
});

assert(emptyThenSuccessCalls === 2, `empty digest response should retry once, got ${emptyThenSuccessCalls} calls`);
assert(retryResult.title === 'Retry Worked', 'retry digest should use second successful markdown');

console.log('✅ digest empty-response retry test passed');
