/**
 * Centralized Model Configuration
 *
 * All LLM model strings in one place. Every model is env-overridable for experimentation.
 * Dual-agent architecture: Sonnet navigates, Opus captures and rescues.
 */
export const ModelConfig = {
    // Stories navigation — cheap model, tight mechanical loop (click avatar, advance, escape)
    stories: process.env.KOWALSKI_STORIES_MODEL || 'claude-sonnet-4-6',

    // Feed navigation — fast model, handles scrolling, clicking, dismissing popups
    navigation: process.env.KOWALSKI_NAV_MODEL || 'claude-sonnet-4-6',

    // Specialist — handles captures, carousels, stuck recovery
    specialist: process.env.KOWALSKI_SPECIALIST_MODEL || 'claude-sonnet-4-6',

    // Content extraction from viewport screenshots — called per capture
    vision: process.env.KOWALSKI_VISION_MODEL || 'claude-sonnet-4-6',

    // Image tagging — categorize and describe captured screenshots
    tagging: process.env.KOWALSKI_TAGGING_MODEL || 'claude-sonnet-4-6',

    // Per-image structured extraction (Extractor agent) — runs vision once per raw screenshot
    // and writes the result into the sidecar JSON. Sonnet because small overlay text matters.
    extraction: process.env.KOWALSKI_EXTRACTION_MODEL || 'claude-sonnet-4-6',

    // Batch digest generation — text-only synthesis from extracted sidecars.
    // Defaults to Haiku because all visual extraction was done upstream.
    digest: process.env.KOWALSKI_DIGEST_MODEL || 'claude-haiku-4-5',

    // Analysis and insights generation
    analysis: process.env.KOWALSKI_ANALYSIS_MODEL || 'claude-sonnet-4-6',
} as const;
