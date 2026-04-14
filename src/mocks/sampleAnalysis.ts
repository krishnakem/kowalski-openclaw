export interface AnalysisSection {
    heading: string;
    content: string[]; // Array of paragraphs
}

export interface AnalysisObject {
    title: string;
    subtitle: string;
    sections: AnalysisSection[];
}

export const sampleAnalysis: AnalysisObject = {
    title: "The Sunday Reflection",
    subtitle: "A deep dive into the week's events and their impact on your digital life.",
    sections: [
        {
            heading: "The Digital Renaissance",
            content: [
                "In the quiet corners of the internet, a new movement is taking shape. Users are reclaiming their attention spans, trading infinite scrolls for finite, meaningful interactions. This shift represents not just a change in habit, but a fundamental restructuring of how we value our time online.",
                "The metrics of success are evolving. Engagement is no longer measured in clicks and likes, but in depth of understanding and genuine connection. Communities are forming around shared intellectual pursuits rather than viral trends, signaling a return to the early promise of the web.",
                "As we navigate this transition, tools that prioritize clarity and focus become essential. The noise of the information age is being filtered through new lenses, allowing us to see the signal more clearly than ever before."
            ]
        },
        {
            heading: "Design in the Age of AI",
            content: [
                "Artificial intelligence is reshaping the landscape of creative work, but the human touch remains irreplaceable. The interplay between algorithmic efficiency and human intuition is creating a new design language—one that is both precise and organic.",
                "Designers are finding that AI serves best as a collaborator rather than a replacement. By offloading routine tasks, creatives are free to explore more abstract and conceptual territories. The result is a fusion of technological capability and artistic expression that was previously impossible.",
                "We are witnessing the birth of 'hybrid aesthetics', where the perfection of machine-generated geometry meets the deliberate imperfections of hand-crafted art. This juxtaposition creates a visual tension that is both arresting and deeply human."
            ]
        },
        {
            heading: "The Return to Print Logic",
            content: [
                "There is a growing nostalgia for the permanence of print. In an ephemeral digital world, the idea of a 'daily edition' that finishes is radical. It offers a sense of completion that the infinite feed cannot provide.",
                "This 'print logic' is influencing modern UI design. Interfaces are becoming cleaner, more pagination-based, and less reliant on constant updates. The calming effect of static text on a page is being rediscovered and valued.",
                "As we look forward, we can expect more applications to adopt these principles. The future of digital consumption may well look a lot like the past—structured, curated, and finite."
            ]
        }
    ]
};
