import { ReactNode } from "react";

/**
 * Minimal markdown renderer for editorial digests.
 *
 * Supported block elements: # / ## / ### headings, paragraphs, horizontal rules.
 * Supported inline elements: **bold**, *italic*, `code`.
 *
 * The Digest Agent emits a tightly-constrained subset; if it ever produces
 * something fancier (lists, blockquotes), they degrade to plain paragraphs.
 */

function renderInline(text: string, keyPrefix: string): ReactNode[] {
    // Tokenize bold/italic/code inline. Process bold first (greedy on **),
    // then italic, then code.
    const out: ReactNode[] = [];
    const pattern = /(\*\*([^*]+)\*\*|\*([^*\n]+)\*|`([^`\n]+)`)/g;
    let lastIndex = 0;
    let match: RegExpExecArray | null;
    let i = 0;
    while ((match = pattern.exec(text)) !== null) {
        if (match.index > lastIndex) {
            out.push(text.slice(lastIndex, match.index));
        }
        const key = `${keyPrefix}-${i++}`;
        if (match[2] !== undefined) {
            out.push(<strong key={key} className="font-semibold text-foreground">{match[2]}</strong>);
        } else if (match[3] !== undefined) {
            out.push(<em key={key}>{match[3]}</em>);
        } else if (match[4] !== undefined) {
            out.push(<code key={key} className="font-mono text-sm bg-muted px-1 py-0.5 rounded">{match[4]}</code>);
        }
        lastIndex = match.index + match[0].length;
    }
    if (lastIndex < text.length) {
        out.push(text.slice(lastIndex));
    }
    return out;
}

export function renderMarkdown(markdown: string): ReactNode {
    const lines = markdown.replace(/\r\n/g, '\n').split('\n');
    const blocks: ReactNode[] = [];
    let paragraph: string[] = [];
    let blockKey = 0;

    const flushParagraph = () => {
        if (!paragraph.length) return;
        const text = paragraph.join(' ').trim();
        paragraph = [];
        if (!text) return;
        blocks.push(
            <p
                key={`p-${blockKey++}`}
                className="font-serif text-foreground text-base leading-relaxed mb-4"
            >
                {renderInline(text, `p-${blockKey}`)}
            </p>
        );
    };

    for (const rawLine of lines) {
        const line = rawLine.trimEnd();

        if (!line.trim()) {
            flushParagraph();
            continue;
        }

        if (/^---+\s*$/.test(line)) {
            flushParagraph();
            blocks.push(
                <hr key={`hr-${blockKey++}`} className="my-8 border-border/40" />
            );
            continue;
        }

        const h1 = line.match(/^#\s+(.+)$/);
        if (h1) {
            flushParagraph();
            blocks.push(
                <h1
                    key={`h1-${blockKey++}`}
                    className="font-serif text-4xl md:text-5xl font-bold text-foreground leading-tight text-center mt-2 mb-3"
                >
                    {renderInline(h1[1], `h1-${blockKey}`)}
                </h1>
            );
            continue;
        }

        const h2 = line.match(/^##\s+(.+)$/);
        if (h2) {
            flushParagraph();
            blocks.push(
                <h2
                    key={`h2-${blockKey++}`}
                    className="font-serif text-2xl font-semibold text-foreground leading-tight mt-8 mb-3"
                >
                    {renderInline(h2[1], `h2-${blockKey}`)}
                </h2>
            );
            continue;
        }

        const h3 = line.match(/^###\s+(.+)$/);
        if (h3) {
            flushParagraph();
            blocks.push(
                <h3
                    key={`h3-${blockKey++}`}
                    className="font-sans uppercase tracking-wide text-sm text-muted-foreground text-center mb-6"
                >
                    {renderInline(h3[1], `h3-${blockKey}`)}
                </h3>
            );
            continue;
        }

        paragraph.push(line);
    }
    flushParagraph();

    return <>{blocks}</>;
}
