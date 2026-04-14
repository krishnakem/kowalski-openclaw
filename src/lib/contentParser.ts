/**
 * Content Parser - Parse LLM-generated digest bullets into structured data
 *
 * Input format: "• **@handle**: Content text. [Contextual Analysis: This could impact...]"
 * Output: Structured ParsedItem with handle, content, and optional analysis
 */

export interface ParsedItem {
    handle: string;           // "@username" (without asterisks)
    content: string;          // Main content text
    analysis?: string;        // Contextual analysis if present
    raw: string;              // Original unparsed string
}

export interface ParsedSection {
    emoji: string;            // Section emoji (e.g., "🎯")
    category: string;         // Section category (e.g., "Strategic Interests")
    subcategory?: string;     // Optional subcategory (e.g., "michigan athletics")
    items: ParsedItem[];
    isLightningRound: boolean;
}

/**
 * Parse a single content bullet into structured data.
 *
 * Handles formats:
 * - "• **@handle**: Content. [Contextual Analysis: ...]"
 * - "• **@handle**: Content."
 * - "**@handle**: Content." (without bullet)
 * - "· **@handle**: Content." (middle dot)
 */
export function parseContentItem(raw: string): ParsedItem {
    // Clean up the string
    const cleaned = raw.trim().replace(/^[•·]\s*/, '');

    // Extract handle: **@handle** or just @handle. Empty string when missing —
    // upstream agent should not be emitting handle-less items.
    const handleMatch = cleaned.match(/\*\*(@[\w._]+)\*\*:?|(@[\w._]+):/);
    const handle = handleMatch?.[1] || handleMatch?.[2] || '';

    // Remove the handle part from the content
    let remaining = cleaned
        .replace(/\*\*@[\w._]+\*\*:?\s*/, '')
        .replace(/@[\w._]+:\s*/, '')
        .trim();

    // Extract contextual analysis if present
    let analysis: string | undefined;
    const analysisMatch = remaining.match(/\[Contextual Analysis:\s*([^\]]+)\]/i);
    if (analysisMatch) {
        analysis = analysisMatch[1].trim();
        remaining = remaining.replace(/\[Contextual Analysis:\s*[^\]]+\]/i, '').trim();
    }

    // Also check for inline analysis format: "Content. Analysis in different format."
    // Some LLMs use: "Content. This could impact..." without brackets
    // We'll be conservative and only extract bracketed analysis

    // Clean up trailing punctuation if analysis was extracted
    const content = remaining.replace(/\.\s*$/, '').trim() + (remaining.endsWith('.') ? '' : '');

    return {
        handle,
        content: content || remaining,
        analysis,
        raw
    };
}

/**
 * Parse a section heading into emoji and category.
 *
 * Handles formats:
 * - "🎯 Strategic Interests: michigan athletics"
 * - "🌍 Global Intelligence"
 * - "⚡ Lightning Round"
 */
export function parseSectionHeading(heading: string): {
    emoji: string;
    category: string;
    subcategory?: string;
} {
    // Extract emoji (first character if it's an emoji)
    const emojiMatch = heading.match(/^([\p{Emoji}])\s*/u);
    const emoji = emojiMatch?.[1] || '';

    // Remove emoji from heading
    const textPart = heading.replace(/^[\p{Emoji}]\s*/u, '').trim();

    // Check for subcategory (after colon)
    const colonIndex = textPart.indexOf(':');
    if (colonIndex !== -1) {
        return {
            emoji,
            category: textPart.slice(0, colonIndex).trim(),
            subcategory: textPart.slice(colonIndex + 1).trim()
        };
    }

    return {
        emoji,
        category: textPart
    };
}

/**
 * Parse an entire section (heading + content array) into structured data.
 */
export function parseSection(heading: string, content: string[]): ParsedSection {
    const { emoji, category, subcategory } = parseSectionHeading(heading);

    // Check if this is lightning round (compact display)
    const isLightningRound = category.toLowerCase().includes('lightning');

    // Parse each content item
    const items = content.map(parseContentItem);

    return {
        emoji,
        category,
        subcategory,
        items,
        isLightningRound
    };
}

/**
 * Determine the display variant for a section based on its content.
 */
export function getSectionVariant(section: ParsedSection): 'featured' | 'standard' | 'compact' {
    if (section.isLightningRound) {
        return 'compact';
    }

    // First section with "Strategic" or "Interests" gets featured treatment
    if (section.category.toLowerCase().includes('strategic') ||
        section.category.toLowerCase().includes('interests')) {
        return 'featured';
    }

    return 'standard';
}
