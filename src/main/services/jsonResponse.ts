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

    const repaired = repairTruncatedObject(trimmed);
    if (repaired) candidates.push(repaired);

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

function repairTruncatedObject(text: string): string | null {
    const start = text.indexOf('{');
    if (start < 0) return null;

    let candidate = text.slice(start).trim();
    const fence = candidate.indexOf('```');
    if (fence >= 0) candidate = candidate.slice(0, fence).trim();

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

    if (inString) candidate += '"';

    candidate = candidate.trimEnd();
    while (candidate.endsWith(',')) {
        candidate = candidate.slice(0, -1).trimEnd();
    }
    if (candidate.endsWith(':')) {
        candidate += ' null';
    }

    for (let i = closers.length - 1; i >= 0; i--) candidate += closers[i];

    return candidate;
}
