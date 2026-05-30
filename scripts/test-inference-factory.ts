import { createInferenceClient, type OpenClawRuntimeLike } from '../src/main/services/Inference.js';

function assert(cond: unknown, message: string): asserts cond {
    if (!cond) throw new Error(message);
}

const runtime: OpenClawRuntimeLike = {
    config: { current: () => ({}) },
    llm: {
        complete: async () => ({
            text: 'ok',
            provider: 'test',
            model: 'test-model',
            usage: { inputTokens: 1, outputTokens: 1 },
        }),
    },
    mediaUnderstanding: {
        describeImageFile: async () => ({ text: 'ok', provider: 'test', model: 'vision' }),
    },
};

const defaultClient = createInferenceClient({ runtime });
assert(defaultClient.backend === 'openclaw', 'default backend should be openclaw');

const openClawNoKey = createInferenceClient({ runtime });
assert(openClawNoKey.backend === 'openclaw', 'openclaw backend should not require a provider-specific key');

let threw = false;
try {
    createInferenceClient({});
} catch {
    threw = true;
}
assert(threw, 'OpenClaw runtime should be required');

console.log('✅ inference factory tests passed');
