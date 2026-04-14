export interface AnalysisSection {
    heading: string;
    content: string[]; // Array of paragraphs
}

/**
 * Image metadata for the digest gallery.
 */
export interface DigestImage {
    id: number;
    filename: string;          // "1.jpg"
    source: 'feed' | 'story' | 'profile' | 'carousel';
}

/**
 * Story highlight metadata for the stories carousel.
 * LLM curates which stories are interesting and extracts account names.
 */
export interface StoryHighlight {
    imageId: number;           // References DigestImage.id
    account: string;           // @username extracted from screenshot
    summary: string;           // Brief description of story content
}

export interface AnalysisObject {
    title: string;
    subtitle: string;
    date: string | Date; // ISO string for storage, Date object in runtime
    location: string;
    scheduledTime: string; // e.g., "10:00 AM" - the slot this was triggered for
    sections: AnalysisSection[];

    // Editorial markdown body (new format). When present, renderer prefers this
    // over `sections`. Begins with `# Title` chosen by the digest agent.
    markdown?: string;

    // Image gallery data
    images?: DigestImage[];
    featuredImages?: number[];  // Image IDs highlighted as hero images

    // Stories carousel data (LLM-curated interesting stories only)
    storyHighlights?: StoryHighlight[];
}

export interface ArchivedAnalysis {
    id: string;
    data: AnalysisObject;
    leadStoryPreview: string; // for quick display in lists
}
