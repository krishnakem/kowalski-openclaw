import { createInferenceClient, type OpenClawRuntimeLike } from '../src/main/services/Inference.js';

function assert(cond: unknown, message: string): asserts cond {
    if (!cond) throw new Error(message);
}

let forwardedModel: string | undefined;
let forwardedMaxTokens: number | undefined;
let forwardedPurpose: string | undefined;

const runtime: OpenClawRuntimeLike = {
    config: { current: () => ({}) },
    llm: {
        complete: async (params) => {
            forwardedModel = params.model;
            forwardedMaxTokens = params.maxTokens;
            forwardedPurpose = params.purpose;
            return {
                text: 'ok',
                provider: 'test',
                model: params.model ?? 'test-model',
                usage: { inputTokens: 1, outputTokens: 1 },
            };
        },
    },
    mediaUnderstanding: {
        describeImageFile: async () => ({ text: 'ok', provider: 'test', model: 'vision' }),
    },
};

const defaultClient = createInferenceClient({ runtime });
assert(defaultClient.backend === 'openclaw', 'default backend should be openclaw');

const openClawNoKey = createInferenceClient({ runtime });
assert(openClawNoKey.backend === 'openclaw', 'openclaw backend should not require a provider-specific key');

await openClawNoKey.complete({
    model: 'provider/test-digest-model',
    prompt: 'hello',
    maxTokens: 123,
    purpose: 'unit test',
});
assert(forwardedModel === undefined, 'text completions should not forward request.model; OpenClaw owns plugin LLM model selection');
assert(forwardedMaxTokens === 123, 'text completions should forward maxTokens');
assert(forwardedPurpose === 'unit test', 'text completions should forward purpose');

let threw = false;
try {
    createInferenceClient({});
} catch {
    threw = true;
}
assert(threw, 'OpenClaw runtime should be required');

console.log('✅ inference factory tests passed');
