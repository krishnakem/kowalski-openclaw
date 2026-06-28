import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

export type InferenceBackend = 'openclaw';

export interface InferenceUsage {
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
    totalTokens?: number;
    costUsd?: number;
}

export interface InferenceResult {
    text: string;
    provider?: string;
    model?: string;
    usage?: InferenceUsage;
    raw?: unknown;
}

export interface InferenceImage {
    buffer: Buffer;
    mime?: string;
    label?: string;
}

export type InferenceMessageContent =
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }
    >;

export interface InferenceMessage {
    role: 'system' | 'user' | 'assistant';
    content: InferenceMessageContent;
}

export interface InferenceRequest {
    model?: string;
    systemPrompt?: string;
    prompt?: string;
    messages?: InferenceMessage[];
    images?: InferenceImage[];
    maxTokens?: number;
    timeoutMs?: number;
    signal?: AbortSignal;
    purpose?: string;
    expectJson?: boolean;
}

export interface InferenceClient {
    readonly backend: InferenceBackend;
    complete(request: InferenceRequest): Promise<InferenceResult>;
}

export function formatInferenceSource(provider?: string, model?: string): string {
    if (provider && model) return `${provider}/${model}`;
    if (model) return model;
    if (provider) return provider;
    return 'OpenClaw runtime';
}

export interface OpenClawRuntimeLike {
    config?: {
        current?: () => unknown;
    };
    llm?: {
        complete?: (params: {
            messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>;
            model?: string;
            maxTokens?: number;
            temperature?: number;
            systemPrompt?: string;
            signal?: AbortSignal;
            purpose?: string;
            agentId?: string;
        }) => Promise<{
            text: string;
            provider: string;
            model: string;
            agentId?: string;
            usage: InferenceUsage;
            audit?: unknown;
        }>;
    };
    mediaUnderstanding?: {
        describeImageFile?: (params: {
            filePath: string;
            mediaUrl?: string;
            cfg: unknown;
            agentDir?: string;
            workspaceDir?: string;
            mime?: string;
            prompt?: string;
            timeoutMs?: number;
        }) => Promise<{
            text?: string;
            provider?: string;
            model?: string;
            output?: unknown;
            decision?: unknown;
        }>;
    };
}

export interface OpenClawInferenceOptions {
    runtime: OpenClawRuntimeLike;
    scratchDir: string;
    agentDir?: string;
    workspaceDir?: string;
}

export function inferenceUsageToTokenUsage(usage?: InferenceUsage): any {
    if (!usage) return undefined;
    return {
        input_tokens: usage.inputTokens || 0,
        output_tokens: usage.outputTokens || 0,
        cache_creation_input_tokens: usage.cacheWriteTokens || 0,
        cache_read_input_tokens: usage.cacheReadTokens || 0,
    };
}

export class OpenClawInferenceClient implements InferenceClient {
    readonly backend = 'openclaw' as const;
    private runtime: OpenClawRuntimeLike;
    private scratchDir: string;
    private agentDir?: string;
    private workspaceDir?: string;

    constructor(options: OpenClawInferenceOptions) {
        this.runtime = options.runtime;
        this.scratchDir = options.scratchDir;
        this.agentDir = options.agentDir;
        this.workspaceDir = options.workspaceDir;
    }

    async complete(request: InferenceRequest): Promise<InferenceResult> {
        const images = request.images ?? imagesFromMessages(request.messages);
        const prompt = flattenPrompt(request);

        if (images.length > 0) {
            return this.completeWithImages(request, prompt, images);
        }

        const complete = this.runtime.llm?.complete;
        if (!complete) {
            throw new Error('OpenClaw runtime llm.complete is unavailable');
        }

        const result = await complete({
            messages: textMessagesFromRequest(request, prompt),
            maxTokens: request.maxTokens,
            signal: request.signal,
            purpose: request.purpose,
        });

        return {
            text: result.text,
            provider: result.provider,
            model: result.model,
            usage: result.usage,
            raw: result,
        };
    }

    private async completeWithImages(
        request: InferenceRequest,
        prompt: string,
        images: InferenceImage[]
    ): Promise<InferenceResult> {
        const describeImageFile = this.runtime.mediaUnderstanding?.describeImageFile;
        const currentConfig = this.runtime.config?.current;
        if (!describeImageFile || !currentConfig) {
            throw new Error('OpenClaw runtime mediaUnderstanding.describeImageFile is unavailable');
        }

        const tempDir = path.join(this.scratchDir || os.tmpdir(), 'inference-media');
        fs.mkdirSync(tempDir, { recursive: true });
        const outputs: string[] = [];
        let provider: string | undefined;
        let model: string | undefined;
        const written: string[] = [];

        try {
            for (let i = 0; i < images.length; i++) {
                const image = images[i];
                const ext = mimeToExtension(image.mime);
                const filePath = path.join(tempDir, `${Date.now()}-${process.pid}-${i}${ext}`);
                fs.writeFileSync(filePath, image.buffer);
                written.push(filePath);

                const label = image.label || `image ${i + 1}`;
                const imagePrompt = images.length === 1
                    ? prompt
                    : `${prompt}\n\nAnalyze only ${label} of ${images.length}.`;
                const result = await describeImageFile({
                    filePath,
                    cfg: currentConfig(),
                    agentDir: this.agentDir,
                    workspaceDir: this.workspaceDir,
                    mime: image.mime ?? 'image/jpeg',
                    prompt: imagePrompt,
                    timeoutMs: request.timeoutMs,
                });

                if (result.provider) provider = result.provider;
                if (result.model) model = result.model;
                outputs.push(images.length === 1 ? (result.text ?? '') : `[${label}]\n${result.text ?? ''}`);
            }
        } finally {
            for (const filePath of written) {
                try {
                    fs.unlinkSync(filePath);
                } catch {
                    // Best-effort cleanup only.
                }
            }
        }

        return {
            text: outputs.join('\n\n').trim(),
            provider,
            model,
        };
    }
}

export function createInferenceClient(options: {
    runtime?: OpenClawRuntimeLike;
    scratchDir?: string;
    agentDir?: string;
    workspaceDir?: string;
}): InferenceClient {
    if (!options.runtime) throw new Error('OpenClaw runtime is required for Kowalski inference');
    return new OpenClawInferenceClient({
        runtime: options.runtime,
        scratchDir: options.scratchDir ?? os.tmpdir(),
        agentDir: options.agentDir,
        workspaceDir: options.workspaceDir,
    });
}

export function flattenPrompt(request: InferenceRequest): string {
    const parts: string[] = [];
    if (request.systemPrompt) parts.push(`System:\n${request.systemPrompt}`);
    if (request.prompt) parts.push(request.prompt);
    if (request.messages) {
        for (const message of request.messages) {
            if (message.role === 'system') {
                parts.push(`System:\n${stringifyContent(message.content)}`);
            } else {
                parts.push(`${message.role.toUpperCase()}:\n${stringifyContent(message.content)}`);
            }
        }
    }
    if (request.expectJson) {
        parts.push([
            'Return ONLY one compact JSON object. No markdown, no code fence, no prose.',
            'Keep all string values short so the object is not truncated.',
            'For navigation JSON, keep "thinking", "intent", "expected_state", "if_wrong", and "memory" to one short sentence each.',
            'The response must start with { and end with }.'
        ].join('\n'));
    }
    return parts.filter(Boolean).join('\n\n');
}

function textMessagesFromRequest(
    request: InferenceRequest,
    fallbackPrompt: string
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
    if (request.messages?.length) {
        return request.messages.map(message => ({
            role: message.role,
            content: stringifyContent(message.content),
        }));
    }
    const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [];
    messages.push({ role: 'user', content: request.prompt ?? fallbackPrompt });
    return messages;
}

function imagesFromMessages(messages?: InferenceMessage[]): InferenceImage[] {
    if (!messages) return [];
    const images: InferenceImage[] = [];
    for (const message of messages) {
        if (!Array.isArray(message.content)) continue;
        for (const block of message.content) {
            if (block.type !== 'image') continue;
            images.push({
                buffer: Buffer.from(block.source.data, 'base64'),
                mime: block.source.media_type,
            });
        }
    }
    return images;
}

function stringifyContent(content: InferenceMessageContent): string {
    if (typeof content === 'string') return content;
    return content.map(block => {
        if (block.type === 'text') return block.text;
        return `[Image: ${block.source.media_type}]`;
    }).join('\n');
}

function mimeToExtension(mime?: string): string {
    if (mime?.includes('png')) return '.png';
    if (mime?.includes('webp')) return '.webp';
    return '.jpg';
}
