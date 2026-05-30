/**
 * Parse a model response that is supposed to be a single JSON object.
 *
 * Some OpenClaw media-understanding providers return valid JSON-shaped text
 * clipped near the end. When the first object is otherwise complete enough,
 * close the dangling string/braces and let the caller decide whether the
 * resulting object has the fields it needs.
 */

export function parseJsonObjectFromText<T>(content: string): T {
    const trimmed = content.trim();
    const candidates = [
        trimmed,
        ...extractCodeBlocks(trimmed),
    ];

    const balanced = extractFirstBalancedObject(trimmed);
    if (balanced) candidates.push(balanced);

    candidates.push(...repairTruncatedObjects(trimmed));

    for (const candidate of candidates) {
        try {
            return JSON.parse(candidate) as T;
        } catch {
            // Try the next candidate.
        }
    }

    throw new SyntaxError(`No JSON object could be parsed from response: ${trimmed.slice(0, 160)}`);
}

function extractCodeBlocks(text: string): string[] {
    const blocks: string[] = [];
    const re = /```(?:json)?\s*([\s\S]*?)\s*```/gi;
    for (const match of text.matchAll(re)) {
        blocks.push(match[1].trim());
    }
    return blocks;
}

function extractFirstBalancedObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }

    return null;
}

function repairTruncatedObjects(text: string): string[] {
    const start = text.indexOf('{');
    if (start < 0) return [];

    let candidate = text.slice(start).trim();
    const fence = candidate.indexOf('```');
    if (fence >= 0) candidate = candidate.slice(0, fence).trim();

    const repairs = new Set<string>();
    for (const cut of findSafeCutPoints(candidate).reverse()) {
        const prefix = candidate.slice(0, cut).trimEnd();
        const closed = closeJsonPrefix(prefix);
        if (closed) repairs.add(closed);
    }

    const closed = closeJsonPrefix(candidate);
    if (closed) repairs.add(closed);

    return [...repairs];
}

function closeJsonPrefix(input: string): string | null {
    let candidate = input.trim();
    if (!candidate.startsWith('{')) return null;

    const closers: string[] = [];
    let inString = false;
    let escaped = false;

    for (let i = 0; i < candidate.length; i++) {
        const ch = candidate[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') inString = true;
        else if (ch === '{') closers.push('}');
        else if (ch === '[') closers.push(']');
        else if ((ch === '}' || ch === ']') && closers[closers.length - 1] === ch) closers.pop();
    }

    candidate = candidate.trimEnd();
    if (inString) candidate += '"';

    while (candidate.endsWith(',')) {
        candidate = candidate.slice(0, -1).trimEnd();
    }
    if (candidate.endsWith(':')) {
        candidate += ' null';
    }

    for (let i = closers.length - 1; i >= 0; i--) candidate += closers[i];

    return candidate;
}

function findSafeCutPoints(text: string): number[] {
    const cuts: number[] = [];
    let inString = false;
    let escaped = false;

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) {
                escaped = false;
            } else if (ch === '\\') {
                escaped = true;
            } else if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
        } else if (ch === ',') {
            cuts.push(i);
        } else if (ch === '{' || ch === '[') {
            cuts.push(i + 1);
        }
    }

    return cuts;
}
